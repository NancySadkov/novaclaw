/** The instance's sole RAG graph. Officer cabinets are ECS components addressed by `agent:<id>`;
 * descendant worker sessions proxy the root officer's cabinet and never own a durable one. */
export * as WorldMemory from "./world-memory"

import { Context, Effect, Layer } from "effect"
import { join } from "node:path"
import { Log } from "@novaclaw/schema/log"
import { makeGlobalNode } from "../effect/app-node"
import { Capability } from "../effect/capability"
import { LayerNode } from "../effect/layer-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { MemoryAccessLedger } from "./access-ledger"
import { MemoryClient } from "./memory-client"
import { MemoryObserved } from "./memory-observed"
import { MemorySetting } from "./memory-setting"
import { MemoryEvent } from "@novaclaw/schema/memory-event"
import { MemoryPrunePolicy } from "./prune-policy"
import { GraphSnapshot } from "./snapshot"
import { WasmMemory } from "./wasm-engine"

export interface Config {
  readonly enabled: boolean
  readonly dim?: number
  /** On-disk world graph directory (default `<instance data>/memory/world`). */
  readonly dbDir?: string
  /** Maximum staged memories in each session or officer cabinet. */
  readonly stagedCap?: number
  /** Background retention cadence in milliseconds. */
  readonly retainEveryMs?: number
}

export type RuntimeStage = "disabled" | "not-loaded" | "loading" | "ready" | "error"
export interface RuntimeStatus {
  readonly stage: RuntimeStage
  readonly detail?: string
}

export class Service extends Context.Service<Service, MemoryClient.Interface>()("@novaclaw/v2/WorldMemory") {}

let currentRuntimeStatus: RuntimeStatus = { stage: "not-loaded" }
let publishBlockedRead: () => string | undefined = () => undefined

export const describeRuntimeStatus = (status: RuntimeStatus, publishBlocked: string | undefined): RuntimeStatus => {
  if (status.stage !== "ready" || publishBlocked === undefined) return status
  const blocked = `durable writes blocked: ${publishBlocked}`
  return { stage: "ready", detail: status.detail === undefined ? blocked : `${status.detail}; ${blocked}` }
}
export const runtimeStatus = (): RuntimeStatus => describeRuntimeStatus(currentRuntimeStatus, publishBlockedRead())

const DEFAULT_STAGED_CAP = 2_000
const DEFAULT_RETAIN_EVERY_MS = 5 * 60_000
const RETAIN_BATCH_SIZE = 16
const RETAIN_BATCH_PAUSE_MS = 100
const RETAIN_BACKLOG_RETRY_MS = 5_000

/** Bound one ECS-owned cabinet using the recall ledger, never another agent's activity. */
export const forgetOverCap = (
  live: WasmMemory,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  scope: string,
  cap: number,
) =>
  Effect.gen(function* () {
    const count = yield* Effect.tryPromise(() => live.stagedCount(scope)).pipe(Effect.orElseSucceed(() => 0))
    const excess = count - Math.max(0, Math.floor(cap))
    if (excess <= 0) return false
    const candidates = yield* Effect.tryPromise(() =>
      live.candidates({
        scopes: [scope],
        relation: "staged",
        order: "oldest",
        limit: Math.min(Math.max(excess * 4, 500), 20_000),
      }),
    ).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<MemoryClient.CandidateRow>))
    const usage = yield* MemoryAccessLedger.usageFor(
      db,
      candidates.map((row) => row.id).filter((id) => id.length > 0),
    )
    const choice = MemoryPrunePolicy.choose({
      candidates: candidates.filter((row) => row.id.length > 0),
      usage,
      excess: Math.min(excess, RETAIN_BATCH_SIZE),
      now: Date.now(),
    })
    let forgotten = 0
    for (const id of choice.victims) {
      const invalidated = yield* Effect.tryPromise(() => live.invalidate(id, undefined, { scopes: [scope] })).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      )
      if (!invalidated) continue
      forgotten++
      yield* events.publish(MemoryEvent.Forgotten, { id, mode: "invalidate" }).pipe(Effect.ignore)
      if (forgotten % (RETAIN_BATCH_SIZE / 2) === 0) yield* Effect.sleep(RETAIN_BATCH_PAUSE_MS)
    }
    return forgotten > 0 && excess > forgotten
  })

export const forgetEverywhere = (
  live: WasmMemory,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  cap: number,
  rawAccessKeep = MemoryAccessLedger.RAW_ROW_HORIZON,
) =>
  Effect.gen(function* () {
    const scopes = [
      ...(yield* Effect.tryPromise(() => live.stagedScopes("session:")).pipe(Effect.orElseSucceed(() => []))),
      ...(yield* Effect.tryPromise(() => live.stagedScopes("agent:")).pipe(Effect.orElseSucceed(() => []))),
      "global",
    ]
    let backlog = false
    for (const scope of new Set(scopes)) backlog = (yield* forgetOverCap(live, db, events, scope, cap)) || backlog
    yield* MemoryAccessLedger.trim(db, rawAccessKeep).pipe(Effect.ignore)
    return backlog
  })

export const configFromFlags = (): Config => ({
  enabled: Flag.NOVACLAW_WORLD_MEMORY,
  ...(Flag.NOVACLAW_WORLD_MEMORY_DIM ? { dim: Number(Flag.NOVACLAW_WORLD_MEMORY_DIM) } : {}),
})

/** Build the independent world-model capability. Opening remains lazy, like the explicit KB. */
export const layerFromConfig = (
  cfg: Config,
): Layer.Layer<Service, never, EventV2.Service | Database.Service> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const ledger = (yield* Database.Service).db
      if (!cfg.enabled) {
        currentRuntimeStatus = { stage: "disabled" }
        return MemoryObserved.observed(MemoryClient.disabled("world memory is disabled"), { events, ledger })
      }

      const dbDir = cfg.dbDir ?? join(Global.Path.data, "memory", "world")
      currentRuntimeStatus = { stage: "not-loaded" }
      publishBlockedRead = () => undefined
      let engine: WasmMemory | undefined
      let opening: Promise<MemoryClient.Interface> | undefined
      const open = () => {
        if (engine) return Promise.resolve(MemoryClient.fromEngine(engine))
        if (opening) return opening
        currentRuntimeStatus = { stage: "loading" }
        opening = WasmMemory.open(dbDir, cfg.dim === undefined ? {} : { dim: cfg.dim })
          .then((opened) => {
            engine = opened
            publishBlockedRead = () => opened.publishBlocked
            currentRuntimeStatus =
              opened.recovery.skipped.length === 0
                ? { stage: "ready" }
                : {
                    stage: "ready",
                    detail:
                      `recovered: opened ${opened.recovery.opened}; skipped ` +
                      opened.recovery.skipped.map((item) => `${item.name} (${item.reason})`).join(", "),
                  }
            return MemoryClient.fromEngine(opened)
          })
          .catch((cause) => {
            currentRuntimeStatus = { stage: "error", detail: String(cause).slice(0, 300) }
            Effect.runFork(Log.event("kb.memory.open.failed", { "kb.cause": Log.fault(cause) }))
            throw cause
          })
          .finally(() => {
            opening = undefined
          })
        return opening
      }

      const client = <A>(run: (live: MemoryClient.Interface) => Effect.Effect<A, MemoryClient.MemoryError>) =>
        Effect.tryPromise({
          try: open,
          catch: (cause) => new MemoryClient.MemoryError({ reason: String(cause).slice(0, 300) }),
        }).pipe(Effect.flatMap(run))

      const durableStoreExists = () => {
        try {
          return GraphSnapshot.candidates(dbDir).length > 0
        } catch {
          return true
        }
      }
      const mutateExistingStore = (
        run: (live: MemoryClient.Interface) => Effect.Effect<void, MemoryClient.MemoryError>,
      ) => Effect.suspend(() => (engine !== undefined || opening !== undefined || durableStoreExists() ? client(run) : Effect.void))

      const lazyClient: MemoryClient.Interface = {
        health: () => client((live) => live.health()).pipe(Effect.orElseSucceed(() => false)),
        addMemory: (input) => client((live) => live.addMemory(input)),
        addEdge: (input, access) => client((live) => live.addEdge(input, access)),
        search: (input) => client((live) => live.search(input)),
        neighbors: (id, access, opts) => client((live) => live.neighbors(id, access, opts)),
        get: (id, access) => client((live) => live.get(id, access)),
        path: (from, to, access, maxHops) => client((live) => live.path(from, to, access, maxHops)),
        invalidate: (id, access, at) => client((live) => live.invalidate(id, access, at)),
        purge: (id, access) => client((live) => live.purge(id, access)),
        addClaim: (input, access) => client((live) => live.addClaim(input, access)),
        claimHistory: (id, access) => client((live) => live.claimHistory(id, access)),
        reviewEvidence: (locator, access) => client((live) => live.reviewEvidence(locator, access)),
        setClaimStatus: (id, status, access) => client((live) => live.setClaimStatus(id, status, access)),
        moveScope: (from, to) => mutateExistingStore((live) => live.moveScope(from, to)),
        clearScope: (scope) => mutateExistingStore((live) => live.clearScope(scope)),
        eraseAll: () => client((live) => live.eraseAll()),
        discardLegacyGlobalExtracts: () => client((live) => live.discardLegacyGlobalExtracts()),
        stats: () => client((live) => live.stats()),
        list: (input) => client((live) => live.list(input)),
        candidates: (input) => client((live) => live.candidates(input)),
        byIds: (ids) => client((live) => live.byIds(ids)),
        graph: (input) => client((live) => live.graph(input)),
      }

      // World memory never consolidates into `global`. Retention is still active, independently per
      // session and officer cabinet, so a busy conversation cannot evict another officer's world.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const cap = cfg.stagedCap ?? DEFAULT_STAGED_CAP
          let nextDelay = cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS
          for (;;) {
            yield* Effect.sleep(nextDelay)
            const live = engine
            // The user privacy switch gates retention too. A separate graph must not become a
            // loophole where automatic world memories keep being rewritten after memory is off.
            if (!live || !MemorySetting.memoryEnabled()) {
              nextDelay = cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS
              continue
            }
            const backlog = yield* forgetEverywhere(live, ledger, events, cap)
            nextDelay = backlog ? RETAIN_BACKLOG_RETRY_MS : (cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS)
          }
        }),
      )
      yield* Effect.addFinalizer(() => Effect.promise(async () => engine && (await engine.close())))
      return MemoryObserved.observed(lazyClient, { events, ledger })
    }),
  )

export const layer = layerFromConfig(configFromFlags())

export const serviceNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, EventV2.node],
})

export const node = LayerNode.capability(serviceNode, {
  name: "world-memory",
  service: Service,
  timeout: "30 seconds",
  repair: ["runtime_flags.NOVACLAW_WORLD_MEMORY"],
})

export const client = (capability: Capability.Capability<MemoryClient.Interface>): MemoryClient.Interface => {
  const withClient = <A>(
    run: (world: MemoryClient.Interface) => Effect.Effect<A, MemoryClient.MemoryError>,
  ): Effect.Effect<A, MemoryClient.MemoryError> =>
    capability.get.pipe(
      Effect.flatMap((result) => run(result.ok ? result.value : MemoryClient.disabled(result.error.summary))),
    )
  return {
    health: () => capability.get.pipe(Effect.flatMap((result) => (result.ok ? result.value.health() : Effect.succeed(false)))),
    addMemory: (input) => withClient((world) => world.addMemory(input)),
    addEdge: (input, access) => withClient((world) => world.addEdge(input, access)),
    search: (input) => withClient((world) => world.search(input)),
    neighbors: (id, access, opts) => withClient((world) => world.neighbors(id, access, opts)),
    get: (id, access) => withClient((world) => world.get(id, access)),
    path: (from, to, access, maxHops) => withClient((world) => world.path(from, to, access, maxHops)),
    invalidate: (id, access, at) => withClient((world) => world.invalidate(id, access, at)),
    purge: (id, access) => withClient((world) => world.purge(id, access)),
    addClaim: (input, access) => withClient((world) => world.addClaim(input, access)),
    claimHistory: (id, access) => withClient((world) => world.claimHistory(id, access)),
    reviewEvidence: (locator, access) => withClient((world) => world.reviewEvidence(locator, access)),
    setClaimStatus: (id, status, access) => withClient((world) => world.setClaimStatus(id, status, access)),
    moveScope: (from, to) => withClient((world) => world.moveScope(from, to)),
    clearScope: (scope) => withClient((world) => world.clearScope(scope)),
    eraseAll: () => withClient((world) => world.eraseAll()),
    discardLegacyGlobalExtracts: () => withClient((world) => world.discardLegacyGlobalExtracts()),
    stats: () => withClient((world) => world.stats()),
    list: (input) => withClient((world) => world.list(input)),
    candidates: (input) => withClient((world) => world.candidates(input)),
    byIds: (ids) => withClient((world) => world.byIds(ids)),
    graph: (input) => withClient((world) => world.graph(input)),
  }
}
