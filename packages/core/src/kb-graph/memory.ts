export * as Memory from "./memory"

import { join } from "node:path"
import { Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { MemoryClient } from "./memory-client"
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
}

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
      // Flush + close the engine on instance shutdown (best-effort; the snapshot persists the graph).
      yield* Effect.addFinalizer(() => Effect.promise(async () => engine && (await engine.close())))
      return MemoryClient.proxy(() => delegate)
    }),
  )

/** The production layer: reads the memory config from env flags. */
export const layer = layerFromConfig(configFromFlags())

export const node = makeGlobalNode({ service: MemoryClient.Service, layer, deps: [] })
