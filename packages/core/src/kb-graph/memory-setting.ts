export * as MemorySetting from "./memory-setting"

// The lay Memory ON/OFF privacy switch (notes/kb-graph-plan.md §5). Two independent gates decide
// whether memory does anything:
//   • NOVACLAW_KB_MEMORY (env)  — CAPABILITY: does the engine open at all (a constrained host / airgap
//     can leave it off). Owned by Memory.node.
//   • memory.enabled (setting)  — the USER's privacy choice, DEFAULT ON. When off, the RUNTIME flows
//     stand down (auto-recall, auto-extraction, the `kb` tool, background consolidation) so nothing is
//     recalled, recorded, or persisted — but the MANAGEMENT surface (the /memory viewer + export/clear)
//     stays live so the user can still see and clear what's already stored.
//
// Read synchronously with a short TTL cache from the settings store (`runtime_setting` key `memory`) —
// the same boot-time sync-read `server-token.ts` uses — so a toggle in Settings applies live (~2s)
// without threading a store service through the runner/tool/consolidation gates. Fail-open: any read
// problem defaults to ENABLED (the opt-out default), so memory only stops when EXPLICITLY turned off.

import { readRowsSync } from "#sqlite"
import { DatabasePath } from "../database/db-path"

const TTL_MS = 2_000
let cachedAt = 0
let cached = true

/** Whether the user has memory turned on (default true). Cheap: a 2s-TTL sync read of one settings row. */
export function memoryEnabled(dbFile?: string): boolean {
  const now = Date.now()
  if (dbFile === undefined && now - cachedAt < TTL_MS) return cached
  const value = readEnabled(dbFile ?? DatabasePath.path())
  if (dbFile === undefined) {
    cachedAt = now
    cached = value
  }
  return value
}

/** Drop the cache (tests; immediate re-read after a settings write). */
export function bust() {
  cachedAt = 0
  cached = true
}

function readEnabled(dbFile: string): boolean {
  try {
    const rows = readRowsSync(dbFile, "SELECT value FROM runtime_setting WHERE key = 'memory'")
    const raw = rows?.[0]?.value
    if (typeof raw !== "string") return true // never set → default on
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    return parsed.enabled !== false // {enabled:false} = off; anything else (incl. {}) = on
  } catch {
    return true // fail-open: a read problem must not silently kill memory
  }
}
