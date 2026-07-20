export * as Memory from "./memory"

import { join } from "node:path"
import { Duration, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { KbEmbedder } from "./embedder"
import { MemoryClient } from "./memory-client"
import { MemorySetting } from "./memory-setting"
import { WasmMemory } from "./wasm-engine"

// Boot-wire the graph-memory engine INTO the instance (§2.0). The engine is now WASM IN-PROCESS — the
// single engine that runs everywhere (owner: no separate phone version), no sidecar to spawn, no Node
// child, no native binary, no orphan lifecycle. When enabled, the instance opens the graph in-process
// and provides `MemoryClient.Service` to the kb tool + recall hooks. One engine per instance = the
// single-writer (§4.1); GLOBAL (per-instance) node — config rides an env flag like the global DB path.
// Safe in the boot path:
//   • NON-BLOCKING — opening happens in a background fiber; the client is provided immediately and ops
//     degrade until the engine is ready. Boot never waits on the DB.
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

const DEFAULT_GLOBAL_STAGED_CAP = 5000
// Backfill batch per idle pass — bounded so the drain never monopolises the engine lock or the device.
const EMBED_DRAIN_BATCH = 64

/** Resolve the memory config from env flags (the deployment-level source, per the global-DB precedent). */
export const configFromFlags = (): MemoryConfig => ({
  enabled: Flag.NOVACLAW_KB_MEMORY,
  ...(Flag.NOVACLAW_KB_MEMORY_DIM ? { dim: Number(Flag.NOVACLAW_KB_MEMORY_DIM) } : {}),
})

/** Build the memory layer from an explicit config. Opens the WASM engine in a background fiber so boot
 *  is non-blocking; the finalizer flushes + closes it on instance shutdown. Disabled / open-failure →
 *  a disabled client so the instance still boots. */
export const layerFromConfig = (cfg: MemoryConfig): Layer.Layer<MemoryClient.Service> =>
  Layer.effect(
    MemoryClient.Service,
    Effect.gen(function* () {
      if (!cfg.enabled) return MemoryClient.disabled("memory is disabled (NOVACLAW_KB_MEMORY off)")
      const dbDir = cfg.dbDir ?? join(Global.Path.data, "memory", "graph")
      // Non-blocking open: the client is handed over immediately as a proxy that degrades to a
      // disabled delegate until the engine finishes opening in a background fiber, then swaps to the
      // live in-process client. Open failure stays degraded (never a hard boot dependency).
      let engine: WasmMemory | undefined
      let delegate: MemoryClient.Interface = MemoryClient.disabled("memory engine still opening")
      yield* Effect.forkScoped(
        Effect.tryPromise(() => WasmMemory.open(dbDir, cfg.dim === undefined ? {} : { dim: cfg.dim })).pipe(
          Effect.tap((opened) =>
            Effect.sync(() => {
              engine = opened
              delegate = MemoryClient.fromEngine(opened)
            }),
          ),
          Effect.tapError((cause) => Effect.logWarning(`kb-memory failed to open: ${cause}`)),
          Effect.ignore, // open failure stays degraded — never a hard boot dependency
        ),
      )
      // Background consolidation (§1.3.4): periodically promote this instance's session memories to
      // global so auto-extracted facts become cross-session. Best-effort; a no-op until the engine is
      // live. Runs off the turn hot-path (a forked fiber, stopped on scope close).
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
      return MemoryClient.proxy(() => delegate)
    }),
  )

/** The production layer: reads the memory config from env flags. */
export const layer = layerFromConfig(configFromFlags())

export const node = makeGlobalNode({ service: MemoryClient.Service, layer, deps: [] })
