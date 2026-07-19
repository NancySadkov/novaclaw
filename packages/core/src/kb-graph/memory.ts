export * as Memory from "./memory"

import { randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { MemoryClient } from "./memory-client"
import { Sidecar } from "./sidecar"

// Boot-wire the graph-memory engine INTO the instance (the owner's ask: no server to provision — a
// phone/cheap-laptop user just launches the app and the DB comes up with it). When an entry is
// configured, the instance AUTO-SPAWNS + supervises the on-device Node sidecar (loopback-only, never
// egresses) and provides `MemoryClient.Service` to the kb tool + recall hooks. One engine per
// instance = the single-writer (§4.1); this is a GLOBAL (per-instance) node — its config rides env
// flags like the global DB path (`NOVACLAW_DB`), resolved by the launcher, NOT location config.
// Two properties make it safe in the boot path:
//   • NON-BLOCKING — the client is handed over immediately; the engine finishes opening in the
//     background (schema + extension load take a beat) and ops just degrade until it's ready.
//   • NEVER A HARD DEPENDENCY — no entry, or the engine can't run here (no Node / spawn fails),
//     yields a `disabled` client so the instance still boots (the "never breaks" vision).
// The graph lives under the instance data dir; deleting the instance data removes it (local-first).

export interface MemoryConfig {
  /** Sidecar entry path; unset → memory disabled. */
  readonly entry?: string
  readonly node?: string
  readonly nodeArgs?: readonly string[]
  /** Embedding dimension (matches the embedding device). Default 1024. */
  readonly dim?: number
  /** Override the on-disk graph path (default `<instance data>/memory/graph`). For tests. */
  readonly dbPath?: string
}

/** Resolve the memory config from env flags (the deployment-level source, per the global-DB precedent). */
export const configFromFlags = (): MemoryConfig => ({
  ...(Flag.NOVACLAW_KB_MEMORY_ENTRY ? { entry: Flag.NOVACLAW_KB_MEMORY_ENTRY } : {}),
  ...(Flag.NOVACLAW_KB_MEMORY_NODE ? { node: Flag.NOVACLAW_KB_MEMORY_NODE } : {}),
  // A DEFINED (even empty) NODE_ARGS wins over the supervisor default — `""` = a compiled `.js`
  // entry (no --experimental-strip-types), e.g. the Spark's Node 18.
  ...(Flag.NOVACLAW_KB_MEMORY_NODE_ARGS !== undefined
    ? { nodeArgs: Flag.NOVACLAW_KB_MEMORY_NODE_ARGS.split(/\s+/).filter(Boolean) }
    : {}),
  ...(Flag.NOVACLAW_KB_MEMORY_DIM ? { dim: Number(Flag.NOVACLAW_KB_MEMORY_DIM) } : {}),
})

/** Build the memory layer from an explicit config. `Layer.effect` provides the scope for the
 *  supervisor's release finalizer. When no entry is set (or the engine can't run), a disabled client
 *  is provided so the instance still boots. */
export const layerFromConfig = (cfg: MemoryConfig): Layer.Layer<MemoryClient.Service> =>
  Layer.effect(
    MemoryClient.Service,
    Effect.gen(function* () {
      if (!cfg.entry) return MemoryClient.disabled("memory is not configured (no NOVACLAW_KB_MEMORY_ENTRY)")
      const dbPath = cfg.dbPath ?? join(Global.Path.data, "memory", "graph")
      yield* Effect.sync(() => mkdirSync(dirname(dbPath), { recursive: true }))
      const sup = Sidecar.superviseSidecar({
        entry: cfg.entry,
        dbPath,
        dim: cfg.dim ?? 1024,
        token: randomUUID(),
        ...(cfg.node ? { node: cfg.node } : {}),
        ...(cfg.nodeArgs ? { nodeArgs: cfg.nodeArgs } : {}),
        onLog: (line) => line && console.log(`[kb-memory] ${line}`),
      })
      // Stop the child when the instance shuts down (the OS frees Ladybug's lock; the per-write
      // CHECKPOINT already left the on-disk WAL clean so the next boot reopens without a crash).
      yield* Effect.addFinalizer(() => Effect.promise(() => sup.stop()))
      return sup.client
    }),
  )

/** The production layer: reads the memory config from env flags. */
export const layer = layerFromConfig(configFromFlags())

export const node = makeGlobalNode({ service: MemoryClient.Service, layer, deps: [] })
