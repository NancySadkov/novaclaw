export * as Memory from "./memory"

import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Capability } from "../effect/capability"
import { LayerNode } from "../effect/layer-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { Log } from "@novaclaw/schema/log"
import { KbEmbedder } from "./embedder"
import { MemoryClient } from "./memory-client"
import { MemoryObserved } from "./memory-observed"
import { MemorySetting } from "./memory-setting"
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
export const runtimeStatus = (): RuntimeStatus => currentRuntimeStatus

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
export const layerFromConfig = (cfg: MemoryConfig): Layer.Layer<MemoryClient.Service> =>
  Layer.effect(
    MemoryClient.Service,
    Effect.gen(function* () {
      if (!cfg.enabled) {
        currentRuntimeStatus = { stage: "disabled" }
        return MemoryClient.disabled("memory is disabled (NOVACLAW_KB_MEMORY off)")
      }
      const dbDir = cfg.dbDir ?? join(Global.Path.data, "memory", "graph")
      currentRuntimeStatus = { stage: "not-loaded" }
      let engine: WasmMemory | undefined
      let opening: Promise<MemoryClient.Interface> | undefined
      const open = () => {
        if (engine) return Promise.resolve(MemoryClient.fromEngine(engine))
        if (opening) return opening
        currentRuntimeStatus = { stage: "loading" }
        opening = WasmMemory.open(dbDir, cfg.dim === undefined ? {} : { dim: cfg.dim })
          .then((opened) => {
            engine = opened
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
      const lazyClient: MemoryClient.Interface = {
        health: () => client((live) => live.health()).pipe(Effect.orElseSucceed(() => false)),
        addMemory: (input) => client((live) => live.addMemory(input)),
        addEdge: (input, access) => client((live) => live.addEdge(input, access)),
        search: (input) => client((live) => live.search(input)),
        neighbors: (id, access, opts) => client((live) => live.neighbors(id, access, opts)),
        path: (from, to, access, maxHops) => client((live) => live.path(from, to, access, maxHops)),
        invalidate: (id, access, at) => client((live) => live.invalidate(id, access, at)),
        purge: (id, access) => client((live) => live.purge(id, access)),
        addClaim: (input, access) => client((live) => live.addClaim(input, access)),
        claimHistory: (id, access) => client((live) => live.claimHistory(id, access)),
        reviewEvidence: (locator, access) => client((live) => live.reviewEvidence(locator, access)),
        setClaimStatus: (id, status, access) => client((live) => live.setClaimStatus(id, status, access)),
        moveScope: (from, to) => client((live) => live.moveScope(from, to)),
        clearScope: (scope) => client((live) => live.clearScope(scope)),
        eraseAll: () => client((live) => live.eraseAll()),
        discardLegacyGlobalExtracts: () => client((live) => live.discardLegacyGlobalExtracts()),
        stats: () => client((live) => live.stats()),
        list: (input) => client((live) => live.list(input)),
        graph: (input) => client((live) => live.graph(input)),
      }
      // Background consolidation (§1.3.4): periodically promote this instance's session memories to
      // global so auto-extracted facts become cross-session. Best-effort; a no-op until the engine is
      // live. Runs off the turn hot-path (a forked fiber, stopped on scope close).
      // 🔴 DISCARD THE PRE-ROSTER LEAK, once, before the background loop starts (owner, 2026-08-22:
      // *"we do not migrate the memories created by Novaclaw versions pre corporate structure — just
      // discard them"*). Auto-extraction used to write to `session:<id>` and consolidation promoted
      // those into `global`, so one colleague's automatically-learned facts became readable by every
      // other. Measured on the owner's own store: 77 such rows in `global`, none in any cabinet.
      //
      // ⚠️ Forked, not awaited: the engine is lazy and this must not hold up the first turn. And
      // idempotent by construction — after one pass the predicate matches nothing, and nothing writes
      // rows that match it again, so there is no "have I run this?" flag to keep true.
      yield* Effect.forkScoped(
        Effect.gen(function* () {
          // ⚠️ **`open()`, not `engine`** — and the first version read the variable, which is
          // `undefined` until something opens the store. The fork ran at boot, found nothing, and
          // returned: the discard was dead on arrival and the 77 leaked rows were still there on the
          // owner's instance a day later. `open()` is the lazy opener the client itself goes through,
          // so this waits for the store rather than racing it.
          //
          // ⚠️ It opens the engine EARLIER than a purely lazy instance would. That is the cost of
          // doing this at all, and it is bounded: one store open per boot, off the turn path, on an
          // instance that was going to open it the first time anything recalled anything.
          yield* Effect.tryPromise(() => open()).pipe(Effect.orElseSucceed(() => undefined))
          const live = engine
          if (!live) return
          const discarded = yield* Effect.tryPromise(() => live.discardLegacyGlobalExtracts()).pipe(
            Effect.orElseSucceed(() => 0),
          )
          if (discarded > 0) yield* Log.event("kb.memory.legacy.discarded", { "memory.rows": discarded })
        }),
      )
      const consolidateEvery = Duration.millis(cfg.consolidateEveryMs ?? 5 * 60_000)
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
              yield* Effect.tryPromise(() => live.prune({ scope: "global", maxStaged: stagedCap })).pipe(Effect.ignore)
              // 🔴 …AND EVERY COLLEAGUE'S CABINET, each capped on its own.
              //
              // Until 2026-08-22 auto-extracted facts were written to `session:<id>` and this pass
              // promoted them into `global`, where the cap above bounded them. That promotion was a
              // LEAK — it made one colleague's automatically-learned facts readable by every other
              // (`runner/maintenance.ts` now files them in `agent:<id>`, which `consolidate` does not
              // touch). Stopping the leak also removed the only thing that bounded them, so the bound
              // moves here: without it a cabinet grows forever and recall quality decays with it.
              //
              // ⚠️ Per scope, never one cap over `agent:%` together: a shared cap lets one talkative
              // officer evict another's memories. Same rule as the colleague rate window.
              for (const scope of yield* Effect.tryPromise(() => live.stagedScopes("agent:")).pipe(
                Effect.orElseSucceed(() => [] as string[]),
              ))
                yield* Effect.tryPromise(() => live.prune({ scope, maxStaged: stagedCap })).pipe(Effect.ignore)
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
      return lazyClient
    }),
  )

/** The production layer: reads the memory config from env flags. */
export const layer = layerFromConfig(configFromFlags())

/** The real service node stays replaceable so forced-failure tests can poison only the deferred work. */
export const serviceNode = makeGlobalNode({ service: MemoryClient.Service, layer, deps: [] })

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
 * 🔴 **This is where the store becomes observable**, because it is the ONE funnel every production
 * caller takes: the `kb` tool, auto-recall in the runner, auto-extraction, the memory HTTP routes
 * and an officer's retirement all obtain their client here. `MemoryObserved.observed` wraps the
 * result, so a lifecycle change announces itself identically whoever caused it — which is the
 * difference between a Memory app that shows the store and one that shows the surfaces somebody
 * remembered to instrument. See `memory-observed.ts` for why it publishes on writes and recalls
 * and on nothing the viewer itself does.
 */
export const client = (capability: Capability.Capability<MemoryClient.Interface>): MemoryClient.Interface =>
  MemoryObserved.observed(unobserved(capability))

/** The bare funnel. Exported for tests that need to prove `observed` is what adds the events. */
export const unobserved = (capability: Capability.Capability<MemoryClient.Interface>): MemoryClient.Interface => {
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
    graph: (input) => withClient((memory) => memory.graph(input)),
  }
}
