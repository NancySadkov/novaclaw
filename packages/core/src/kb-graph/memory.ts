export * as Memory from "./memory"

import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Capability } from "../effect/capability"
import { LayerNode } from "../effect/layer-node"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { Log } from "@novaclaw/schema/log"
import { MemoryEvent } from "@novaclaw/schema/memory-event"
import { MemoryAccessLedger } from "./access-ledger"
import { KbEmbedder } from "./embedder"
import { MemoryPrunePolicy } from "./prune-policy"
import { MemoryClient } from "./memory-client"
import { MemoryObserved } from "./memory-observed"
import { MemorySetting } from "./memory-setting"
import { GraphSnapshot } from "./snapshot"
import { WasmMemory } from "./wasm-engine"

// Boot-wire the graph-memory engine INTO the instance (§2.0). The engine is now WASM IN-PROCESS — the
// single engine that runs everywhere (owner: no separate phone version), no sidecar to spawn, no Node
// child, no native binary, no orphan lifecycle. When enabled, the instance opens the graph in-process
// and provides `MemoryClient.Service` to the kb tool + recall hooks. One engine per instance = the
// single-writer (§4.1); GLOBAL (per-instance) node — config rides an env flag like the global DB path.
// Safe in the boot path:
//   • LAZY — boot provides a lightweight client; the first memory operation opens the engine and
//     concurrent operations share that one open. Instances that never use memory allocate no WASM graph.
//   • NEVER A HARD DEPENDENCY — disabled, or the engine fails to open → a `disabled` client, so the
//     instance still boots (the "never breaks" vision).
// The graph is persisted (MEMFS + snapshot) under the instance data dir; deleting instance data
// removes it (local-first).

export interface MemoryConfig {
  readonly enabled: boolean
  /** Embedding dimension (matches the embedding device). Default 1024. */
  readonly dim?: number
  /** On-disk graph directory (default `<instance data>/memory/graph`). */
  readonly dbDir?: string
  /** How often the background pass consolidates session memories → global (ms). Default 5 min. */
  readonly consolidateEveryMs?: number
  /** Forgetting/decay cap: max valid `staged` GLOBAL memories before the background pass prunes the
   *  lowest-importance (§4.7). Core is never pruned. Default 5000. */
  readonly globalStagedCap?: number
}

export type RuntimeStage = "disabled" | "not-loaded" | "loading" | "ready" | "error"
export interface RuntimeStatus {
  readonly stage: RuntimeStage
  readonly detail?: string
}

let currentRuntimeStatus: RuntimeStatus = { stage: "not-loaded" }
/** Reads the open engine's `publishBlocked`; `undefined` until one is open. */
let publishBlockedRead: () => string | undefined = () => undefined

/**
 * A ready store whose durable writes are not landing is reported as ready WITH the reason, on
 * every read — the same argument `recovery` already makes for the open side ("a silent fallback is
 * indistinguishable from a healthy boot"), applied to the write side. `publishBlocked` was written
 * on every failed checkpoint and read by nothing until 2026-09-03, so a repeating checkpoint
 * failure left the user writing memories that lived only in MEMFS while nova-health said healthy.
 */
export const describeRuntimeStatus = (status: RuntimeStatus, publishBlocked: string | undefined): RuntimeStatus => {
  if (status.stage !== "ready" || publishBlocked === undefined) return status
  const blocked = `durable writes blocked: ${publishBlocked}`
  return { stage: "ready", detail: status.detail === undefined ? blocked : `${status.detail}; ${blocked}` }
}
export const runtimeStatus = (): RuntimeStatus => describeRuntimeStatus(currentRuntimeStatus, publishBlockedRead())

const DEFAULT_GLOBAL_STAGED_CAP = 5000
// Backfill batch per idle pass — bounded so the drain never monopolises the engine lock or the device.
const EMBED_DRAIN_BATCH = 64

/** Resolve the memory config from env flags (the deployment-level source, per the global-DB precedent). */
export const configFromFlags = (): MemoryConfig => ({
  enabled: Flag.NOVACLAW_KB_MEMORY,
  ...(Flag.NOVACLAW_KB_MEMORY_DIM ? { dim: Number(Flag.NOVACLAW_KB_MEMORY_DIM) } : {}),
})

/** Build the memory layer from an explicit config. The WASM engine opens on first use; the finalizer
 * flushes + closes it on instance shutdown. Disabled / open-failure never prevents instance boot. */
export const layerFromConfig = (
  cfg: MemoryConfig,
): Layer.Layer<MemoryClient.Service, never, EventV2.Service | Database.Service> =>
  Layer.effect(
    MemoryClient.Service,
    Effect.gen(function* () {
      /**
       * 🔴 THE BUS AND THE LEDGER ARE CAPTURED HERE, ONCE, AND THE OBSERVED CLIENT IS WHAT THIS
       * LAYER PROVIDES.
       *
       * They used to be read per call inside `MemoryObserved`, with `serviceOption`. Measured
       * 2026-08-25 on a real serve against a real model: the `kb` tool's node does not declare
       * `EventV2`, so that read answered `None` and every `memory.*` event was a silent no-op — an
       * outside subscriber saw nothing across three turns in which the store wrote a claim,
       * corrected it and recalled it, with the whole unit suite green. Capturing at layer build puts
       * the dependency where the node graph can guarantee it (`serviceNode`'s `deps`) and where the
       * compiler enforces it, instead of where each caller has to have remembered it.
       *
       * ⚠️ **And it moves observation off `Memory.client`.** Every consumer resolves
       * `MemoryClient.Service`, so observing what this layer PROVIDES means a caller cannot obtain
       * an unobserved store at all — where before it merely had to remember to call the right
       * helper.
       */
      const events = yield* EventV2.Service
      const ledger = (yield* Database.Service).db
      if (!cfg.enabled) {
        currentRuntimeStatus = { stage: "disabled" }
        // A disabled client fails every operation, so there is nothing for the wrapper to observe —
        // but it is wrapped anyway, because "which client did I get" must never change the shape of
        // what a caller holds.
        return MemoryObserved.observed(MemoryClient.disabled("memory is disabled (NOVACLAW_KB_MEMORY off)"), {
          events,
          ledger,
        })
      }
      const dbDir = cfg.dbDir ?? join(Global.Path.data, "memory", "graph")
      currentRuntimeStatus = { stage: "not-loaded" }
      publishBlockedRead = () => undefined
      let engine: WasmMemory | undefined
      let opening: Promise<MemoryClient.Interface> | undefined
      const open = () => {
        if (engine) return Promise.resolve(MemoryClient.fromEngine(engine))
        if (opening) return opening
        currentRuntimeStatus = { stage: "loading" }
        opening = WasmMemory.open(dbDir, cfg.dim === undefined ? {} : { dim: cfg.dim })
          .then(async (opened) => {
            // Discard the pre-roster global leak before the first caller can observe the store. This
            // used to run in a boot fiber, which made the supposedly lazy capability allocate the
            // WASM engine even when the instance never used memory. Keeping the idempotent cleanup
            // inside the shared open promise preserves the ordering without making boot eager.
            const discarded = await opened.discardLegacyGlobalExtracts().catch(() => 0)
            if (discarded > 0) Effect.runFork(Log.event("kb.memory.legacy.discarded", { "memory.rows": discarded }))
            engine = opened
            publishBlockedRead = () => opened.publishBlocked
            // A store that opened by FALLING BACK is ready, but not the same ready — the user is
            // reading an older generation and some of their newest memories are gone. Reporting it
            // through `detail` puts it in front of nova-health and the instance status without a
            // schema change; a silent fallback is indistinguishable from a healthy boot.
            const fell = opened.recovery.skipped.length > 0
            currentRuntimeStatus = fell
              ? {
                  stage: "ready",
                  detail:
                    `recovered: opened ${opened.recovery.opened}; skipped ` +
                    `${opened.recovery.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}` +
                    (opened.recovery.quarantined.length > 0 ? `; kept: ${opened.recovery.quarantined.join(", ")}` : ""),
                }
              : { stage: "ready" }
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
          // An unreadable path may still contain the user's store. Let the real opener diagnose it;
          // treating uncertainty as absence would silently skip a requested cleanup.
          return true
        }
      }
      const mutateExistingStore = (
        run: (live: MemoryClient.Interface) => Effect.Effect<void, MemoryClient.MemoryError>,
      ) =>
        Effect.suspend(() =>
          engine !== undefined || opening !== undefined || durableStoreExists() ? client(run) : Effect.void,
        )
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
        // Session deletion and colleague retirement are allowed to prove an absent store cheaply.
        // Creating a 1.3 GB WASM engine in order to delete from a store that has never existed is not
        // cleanup; it is a new subsystem allocation on a teardown path.
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
      // Background consolidation (§1.3.4): periodically promote this instance's session memories to
      // global so auto-extracted facts become cross-session. Best-effort; a no-op until the engine is
      // live. Runs off the turn hot-path (a forked fiber, stopped on scope close).
      const consolidateEvery = Duration.millis(cfg.consolidateEveryMs ?? 5 * 60_000)
      /**
       * CONSOLIDATE, THEN FORGET — the background pass, now with the access ledger in the loop.
       *
       * 🔴 `ledger` is the `db` captured above, and it is what makes forgetting read USEFULNESS
       * rather than only age (`forget` below, and `prune-policy.ts` for the reasoning). It is a hard
       * dependency rather than an optional read for the same reason the bus is: an optional one
       * would have made this pass silently fall back to the old age-ordered policy in exactly the
       * environments nobody looks at.
       */
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          const stagedCap = cfg.globalStagedCap ?? DEFAULT_GLOBAL_STAGED_CAP
          for (;;) {
            yield* Effect.sleep(consolidateEvery)
            const live = engine
            // Skip while the user has memory turned off — don't promote or forget anything.
            if (live && MemorySetting.memoryEnabled()) {
              // Consolidate session → global, then forget/decay: bound unbounded global staged growth
              // (§1.3.5/§4.7) — drop the lowest-importance staged over the cap; core is never touched.
              yield* Effect.tryPromise(() => live.consolidate()).pipe(Effect.ignore)
              yield* forgetEverywhere(live, ledger, events, stagedCap)
              // Embed drain: attach vectors to memories stored BEFORE a device was configured (or while
              // it was unreachable), so the vector leg covers the WHOLE graph rather than only new
              // writes — otherwise an instance with history stays effectively keyword-only. Bounded per
              // pass; no device ⇒ embed() yields undefined ⇒ skip and retry next cycle. Belongs here
              // (off the turn hot-path) because bulk embedding costs ~0.2s per item.
              yield* Effect.tryPromise(async () => {
                const pending = await live.pendingEmbeddings(EMBED_DRAIN_BATCH)
                if (pending.length === 0) return
                const vectors = await KbEmbedder.embed(pending.map((row) => row.text))
                if (vectors === undefined) return
                for (const [index, row] of pending.entries()) {
                  const vector = vectors[index]
                  if (vector) await live.setEmbedding(row.id, vector)
                }
              }).pipe(Effect.ignore)
            }
          }
        }),
      )
      // Flush + close the engine on instance shutdown (best-effort; the snapshot persists the graph).
      yield* Effect.addFinalizer(() => Effect.promise(async () => engine && (await engine.close())))
      return MemoryObserved.observed(lazyClient, { events, ledger })
    }),
  )

/**
 * ONE PASS OVER EVERY PILE THAT HAS A CAP: the household's, then each colleague's cabinet.
 *
 * 🔴 **…AND EVERY COLLEAGUE'S CABINET, each capped on its own.** Until 2026-08-22 auto-extracted
 * facts were written to `session:<id>` and consolidation promoted them into `global`, where the
 * household cap bounded them. That promotion was a LEAK — it made one colleague's automatically
 * learned facts readable by every other (`runner/maintenance.ts` now files them in `agent:<id>`,
 * which `consolidate` does not touch). Stopping the leak also removed the only thing that bounded
 * them, so the bound moved here: without it a cabinet grows forever and recall decays with it.
 *
 * ⚠️ **Per scope, never one cap over `agent:%` together.** A shared cap lets one talkative officer
 * evict another's memories — the same rule the colleague rate window follows, and the reason the
 * cabinets are DISCOVERED rather than named: a hardcoded list goes stale the first time somebody is
 * hired.
 *
 * ⚠️ **Extracted from the background fiber so a test can drive it.** The wiring — discover per
 * scope, cap per scope — used to be checked by a guard that read this file's SOURCE for the shape of
 * the call, which went red for a spelling the day the call changed and could never have seen whether
 * the quiet cabinet actually survived. `kb-graph-forgetting-pass.test.ts` drives this against a real
 * engine and a real ledger instead.
 */
export const forgetEverywhere = (
  live: WasmMemory,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  cap: number,
  rawAccessKeep = MemoryAccessLedger.RAW_ROW_HORIZON,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* forgetOverCap(live, db, events, "global", cap)
    for (const scope of yield* Effect.tryPromise(() => live.stagedScopes("agent:")).pipe(
      Effect.orElseSucceed(() => [] as string[]),
    ))
      yield* forgetOverCap(live, db, events, scope, cap)
    // Raw recall detail is deliberately finite; the durable per-memory usage rollup survives this.
    // Running it in the existing maintenance pass gives the bound a production actuator without
    // adding another timer, store owner, or turn-path write.
    yield* MemoryAccessLedger.trim(db, rawAccessKeep)
  })

/**
 * FORGETTING, with the access ledger in the loop.
 *
 * 🔴 **What changed and why it matters.** The retired engine-local policy tiered by `source` and then
 * fell through to `t_created`, so in practice a scope over its cap forgot its OLDEST rows. That is the
 * naive policy the forgetting design exists to avoid: it drops the fact recall reaches for every week
 * and keeps the passage nobody has ever retrieved. `prune-policy.ts` holds the policy and the reasoning;
 * this is the wiring.
 *
 * ⚠️ **Three cheap steps, in this order, because the first two must not run when there is nothing to
 * do.** A count (one aggregate), then a bounded window of SHORT candidate rows, then the ledger's
 * rollup for exactly those ids. A scope inside its cap costs one count and nothing else, which is the
 * common case on every pass.
 *
 * ⚠️ **The window is oldest-first and that IS a bound, not a policy.** The pass needs at least
 * `excess` prunable rows to choose among; it takes them from the old end because that is where stale
 * ones concentrate, and then REORDERS inside the window on provenance, lifecycle, recency and
 * usefulness. The cost of the bound is real and worth naming: a young worthless row can outlive an old
 * valuable one until the window grows to reach it. It converges — the pass runs every five minutes and
 * the window is four times the excess — and the alternative is scanning a whole cabinet every pass.
 *
 * ⚠️ **Exported for its test.** `kb-graph-forgetting-pass.test.ts` drives THIS function against a real
 * engine and a real ledger, which is what replaced a source ledger that asserted the shape of the call
 * this one used to make. A guard that reads the source cannot see whether the quiet cabinet survived.
 *
 */
export const forgetOverCap = (
  live: WasmMemory,
  db: Database.Interface["db"],
  events: EventV2.Interface,
  scope: string,
  cap: number,
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const count = yield* Effect.tryPromise(() => live.stagedCount(scope)).pipe(Effect.orElseSucceed(() => 0))
    const excess = count - Math.max(0, Math.floor(cap))
    if (excess <= 0) return
    const candidates = yield* Effect.tryPromise(() =>
      live.candidates({
        scopes: [scope],
        relation: "staged",
        order: "oldest",
        limit: Math.min(Math.max(excess * 4, 500), 20000),
      }),
    ).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<MemoryClient.CandidateRow>))
    if (candidates.length === 0) return
    const usage = yield* MemoryAccessLedger.usageFor(
      db,
      candidates.map((row) => row.id),
    )
    const choice = MemoryPrunePolicy.choose({ candidates, usage, excess, now: Date.now() })
    for (const id of choice.victims) {
      yield* Effect.tryPromise(() => live.invalidate(id, undefined, { scopes: [scope] })).pipe(Effect.ignore)
      /**
       * 🔴 **THE PASS HAS TO ANNOUNCE ITSELF, and it did not.**
       *
       * `MemoryObserved` wraps the STORE precisely so that "a memory was forgotten" means the same
       * thing whoever forgot it. This loop holds the raw `WasmMemory` — it needs `stagedScopes`,
       * `stagedCount` and `consolidate`, which are engine methods and not on the client — so its
       * `invalidate` reaches around the observed wrapper, and every eviction was silent. Measured
       * 2026-08-26 by `test/kb-graph-forgetting-loop.test.ts`, driving the real layer: the store
       * shrank from six memories to three and the bus carried ZERO `memory.forgotten` events, so an
       * open Memory app kept drawing memories that were gone until something else made it re-read.
       *
       * ⚠️ `events` is a REQUIRED parameter rather than an optional service read, for the reason
       * `memory-observed.ts` records at length: an optional dependency read at the call site means
       * every call site must remember, and the one that forgot is always the one nobody watches.
       */
      yield* events.publish(MemoryEvent.Forgotten, { id, mode: "invalidate" }).pipe(Effect.ignore)
    }
    if (choice.victims.length > 0)
      yield* Log.event("kb.memory.forget.done", {
        "memory.scope": scope,
        "memory.forgotten": choice.victims.length,
        "memory.protected": choice.protectedCount,
      })
  })

/** The production layer: reads the memory config from env flags. */
export const layer = layerFromConfig(configFromFlags())

/** The real service node stays replaceable so forced-failure tests can poison only the deferred work. */
export const serviceNode = makeGlobalNode({
  service: MemoryClient.Service,
  layer,
  deps: [Database.node, EventV2.node],
})

/**
 * Memory is the first client of the generic lazy-capability graph seam. Building the instance now
 * provides only this handle; the lightweight client (and its consolidation fiber) are constructed on
 * the first memory operation. A defect or timeout becomes a disabled client with a named reason.
 */
export const node = LayerNode.capability(serviceNode, {
  name: "memory",
  service: MemoryClient.Service,
  timeout: "30 seconds",
  repair: ["runtime_flags.NOVACLAW_KB_MEMORY"],
})

/**
 * Preserve the MemoryClient operation contract while deferring capability acquisition per call.
 *
 * ⚠️ **Observation no longer lives here.** It used to: this helper wrapped the funnel in
 * `MemoryObserved.observed`, which meant a caller could obtain an unobserved store simply by not
 * using it. `layerFromConfig` now observes what it PROVIDES, so every consumer of
 * `MemoryClient.Service` gets the observed store and this is once again nothing but the deferral.
 */
export const client = (capability: Capability.Capability<MemoryClient.Interface>): MemoryClient.Interface => {
  const withClient = <A>(
    run: (memory: MemoryClient.Interface) => Effect.Effect<A, MemoryClient.MemoryError>,
  ): Effect.Effect<A, MemoryClient.MemoryError> =>
    capability.get.pipe(
      Effect.flatMap((result) => run(result.ok ? result.value : MemoryClient.disabled(result.error.summary))),
    )
  return {
    health: () =>
      capability.get.pipe(Effect.flatMap((result) => (result.ok ? result.value.health() : Effect.succeed(false)))),
    addMemory: (input) => withClient((memory) => memory.addMemory(input)),
    addEdge: (input, access) => withClient((memory) => memory.addEdge(input, access)),
    search: (input) => withClient((memory) => memory.search(input)),
    neighbors: (id, access, opts) => withClient((memory) => memory.neighbors(id, access, opts)),
    get: (id, access) => withClient((memory) => memory.get(id, access)),
    path: (from, to, access, maxHops) => withClient((memory) => memory.path(from, to, access, maxHops)),
    invalidate: (id, access, at) => withClient((memory) => memory.invalidate(id, access, at)),
    purge: (id, access) => withClient((memory) => memory.purge(id, access)),
    addClaim: (input, access) => withClient((memory) => memory.addClaim(input, access)),
    claimHistory: (id, access) => withClient((memory) => memory.claimHistory(id, access)),
    reviewEvidence: (locator, access) => withClient((memory) => memory.reviewEvidence(locator, access)),
    setClaimStatus: (id, status, access) => withClient((memory) => memory.setClaimStatus(id, status, access)),
    moveScope: (from, to) => withClient((memory) => memory.moveScope(from, to)),
    clearScope: (scope) => withClient((memory) => memory.clearScope(scope)),
    eraseAll: () => withClient((memory) => memory.eraseAll()),
    discardLegacyGlobalExtracts: () => withClient((memory) => memory.discardLegacyGlobalExtracts()),
    stats: () => withClient((memory) => memory.stats()),
    list: (input) => withClient((memory) => memory.list(input)),
    candidates: (input) => withClient((memory) => memory.candidates(input)),
    byIds: (ids) => withClient((memory) => memory.byIds(ids)),
    graph: (input) => withClient((memory) => memory.graph(input)),
  }
}
