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
import * as IsolatedMemory from "./isolated-engine"
import type { GraphEngine } from "./isolated-engine"

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
let workerFaultRead: () => string | undefined = () => undefined

export const describeRuntimeStatus = (status: RuntimeStatus, publishBlocked: string | undefined): RuntimeStatus => {
  if (status.stage !== "ready" || publishBlocked === undefined) return status
  const blocked = `durable writes blocked: ${publishBlocked}`
  return { stage: "ready", detail: status.detail === undefined ? blocked : `${status.detail}; ${blocked}` }
}
export const runtimeStatus = (): RuntimeStatus => {
  const fault = workerFaultRead()
  return fault && currentRuntimeStatus.stage === "ready"
    ? { stage: "error", detail: fault }
    : describeRuntimeStatus(currentRuntimeStatus, publishBlockedRead())
}

const DEFAULT_STAGED_CAP = 2_000
const DEFAULT_RETAIN_EVERY_MS = 5 * 60_000
const RETAIN_BATCH_SIZE = 16
const RETAIN_SCOPE_BATCH_SIZE = 8
const RETAIN_BATCH_PAUSE_MS = 100
const RETAIN_BACKLOG_RETRY_MS = 5_000

/** Bound one ECS-owned cabinet using the recall ledger, never another agent's activity. */
export const forgetOverCap = (
  live: GraphEngine,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  scope: string,
  cap: number,
  budget = RETAIN_BATCH_SIZE,
  candidateOffset = 0,
) =>
  Effect.gen(function* () {
    const count = yield* Effect.tryPromise(() => live.stagedCount(scope))
    const excess = count - Math.max(0, Math.floor(cap))
    if (excess <= 0 || budget <= 0)
      return { attempted: 0, forgotten: 0, failed: 0, failure: undefined, backlog: excess > 0, nextCandidateOffset: 0 }
    const offset = candidateOffset >= count ? 0 : candidateOffset
    const limit = Math.min(Math.max(excess * 4, 64), 256)
    const candidates = yield* Effect.tryPromise(() =>
      live.candidates({
        scopes: [scope],
        relation: "staged",
        order: "oldest",
        limit,
        offset,
      }),
    )
    if (candidates.length === 0 && offset > 0)
      return { attempted: 0, forgotten: 0, failed: 0, failure: undefined, backlog: true, nextCandidateOffset: 0 }
    if (candidates.length === 0)
      return yield* Effect.fail(new Error(`memory graph reported ${count} staged rows but returned no candidates in ${scope}`))
    if (candidates.some((row) => row.id.length === 0))
      return yield* Effect.fail(new Error(`memory graph returned blank ids in ${scope}`))
    const usage = yield* MemoryAccessLedger.usageFor(
      db,
      candidates.map((row) => row.id),
    )
    const choice = MemoryPrunePolicy.choose({
      candidates,
      usage,
      excess: Math.min(excess, budget),
      now: Date.now(),
    })
    let attempted = 0
    let forgotten = 0
    let failed = 0
    let failure: string | undefined
    for (const id of choice.victims) {
      attempted++
      const invalidation = yield* Effect.tryPromise(() => live.invalidate(id, undefined, { scopes: [scope] })).pipe(
        Effect.match({ onFailure: (error) => ({ error }), onSuccess: () => ({ success: true }) }),
      )
      if ("success" in invalidation) {
        forgotten++
        yield* events.publish(MemoryEvent.Forgotten, { id, mode: "invalidate" }).pipe(Effect.ignore)
      } else {
        failed++
        failure ??= `${scope}/${id}: ${String(invalidation.error).slice(0, 200)}`
      }
      if (attempted % (RETAIN_BATCH_SIZE / 2) === 0) yield* Effect.sleep(RETAIN_BATCH_PAUSE_MS)
    }
    const nextCandidateOffset = forgotten > 0 || offset + candidates.length >= count ? 0 : offset + candidates.length
    return {
      attempted, forgotten, failed, failure, nextCandidateOffset,
      backlog: (forgotten > 0 && excess > forgotten) || nextCandidateOffset > 0,
    }
  })

export const forgetEverywhere = (
  live: GraphEngine,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  cap: number,
  rawAccessKeep = MemoryAccessLedger.RAW_ROW_HORIZON,
  offset = 0,
  candidateOffsets = new Map<string, number>(),
) =>
  Effect.gen(function* () {
    const scopes = [
      ...new Set([
        ...(yield* Effect.tryPromise(() => live.stagedScopes("session:"))),
        ...(yield* Effect.tryPromise(() => live.stagedScopes("agent:"))),
        "global",
      ]),
    ]
    for (const scope of candidateOffsets.keys()) if (!scopes.includes(scope)) candidateOffsets.delete(scope)
    const start = ((offset % scopes.length) + scopes.length) % scopes.length
    const ordered = [...scopes.slice(start), ...scopes.slice(0, start)]
    let backlog = false
    let attempted = 0
    let forgotten = 0
    let failed = 0
    let failure: string | undefined
    let processed = 0
    for (const scope of ordered) {
      if (attempted >= RETAIN_BATCH_SIZE || processed >= RETAIN_SCOPE_BATCH_SIZE) {
        backlog = true
        break
      }
      const result = yield* forgetOverCap(
        live, db, events, scope, cap, RETAIN_BATCH_SIZE - attempted, candidateOffsets.get(scope) ?? 0,
      )
      if (result.nextCandidateOffset > 0) candidateOffsets.set(scope, result.nextCandidateOffset)
      else candidateOffsets.delete(scope)
      attempted += result.attempted
      forgotten += result.forgotten
      failed += result.failed
      failure ??= result.failure
      backlog = result.backlog || backlog
      processed++
      if (processed < scopes.length) yield* Effect.sleep(RETAIN_BATCH_PAUSE_MS)
    }
    yield* MemoryAccessLedger.trim(db, rawAccessKeep)
    return { backlog: backlog && (forgotten > 0 || attempted === 0), failed, failure, nextOffset: (start + processed) % scopes.length }
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
      workerFaultRead = () => undefined
      let engine: GraphEngine | undefined
      let opening: Promise<MemoryClient.Interface> | undefined
      const open = () => {
        if (engine) return Promise.resolve(MemoryClient.fromEngine(engine))
        if (opening) return opening
        currentRuntimeStatus = { stage: "loading" }
        opening = IsolatedMemory.open(dbDir, cfg.dim === undefined ? {} : { dim: cfg.dim })
          .then((opened) => {
            engine = opened
            publishBlockedRead = () => opened.publishBlocked
            workerFaultRead = () => opened.fault
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
          let nextOffset = 0
          const candidateOffsets = new Map<string, number>()
          for (;;) {
            yield* Effect.sleep(nextDelay)
            const live = engine
            // The user privacy switch gates retention too. A separate graph must not become a
            // loophole where automatic world memories keep being rewritten after memory is off.
            if (!live || !MemorySetting.memoryEnabled()) {
              nextDelay = cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS
              continue
            }
            const retention = yield* forgetEverywhere(
              live,
              ledger,
              events,
              cap,
              MemoryAccessLedger.RAW_ROW_HORIZON,
              nextOffset,
              candidateOffsets,
            ).pipe(Effect.match({ onFailure: (error) => ({ error }), onSuccess: (result) => ({ result }) }))
            if ("error" in retention) {
              currentRuntimeStatus = { stage: "error", detail: `retention failed: ${String(retention.error).slice(0, 300)}` }
              yield* Log.event("kb.memory.retention.failed", { "kb.cause": Log.fault(retention.error) })
              nextDelay = cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS
              continue
            }
            if (retention.result.failed > 0) {
              const detail = `${retention.result.failed} memory erases failed: ${retention.result.failure}`
              currentRuntimeStatus = { stage: "error", detail }
              yield* Log.event("kb.memory.retention.failed", {
                "kb.cause": Log.fault(new Error(detail)),
              })
            }
            if (retention.result.failed === 0 && currentRuntimeStatus.stage === "error" &&
                (currentRuntimeStatus.detail?.startsWith("retention failed:") ||
                  currentRuntimeStatus.detail?.includes("memory erases failed:")))
              currentRuntimeStatus = { stage: "ready" }
            nextOffset = retention.result.nextOffset
            nextDelay = retention.result.backlog ? RETAIN_BACKLOG_RETRY_MS : (cfg.retainEveryMs ?? DEFAULT_RETAIN_EVERY_MS)
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
