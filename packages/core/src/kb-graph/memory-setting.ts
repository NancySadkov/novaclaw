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
  embedAt = 0
  embedCached = undefined
  rerankAt = 0
  rerankCached = true
}

let rerankAt = 0
let rerankCached = true

/** Whether the MODEL orders recalled memories (default true). Off ⇒ metadata ordering only. Same
 *  2s-TTL sync read; fail-open to ON, matching the other memory gates. */
export function rerankEnabled(dbFile?: string): boolean {
  const now = Date.now()
  if (dbFile === undefined && now - rerankAt < TTL_MS) return rerankCached
  let value = true
  try {
    const rows = readRowsSync(dbFile ?? DatabasePath.path(), "SELECT value FROM runtime_setting WHERE key = 'memory'")
    const raw = rows?.[0]?.value
    if (typeof raw === "string") value = (JSON.parse(raw) as { rerank?: unknown }).rerank !== false
  } catch {
    value = true
  }
  if (dbFile === undefined) {
    rerankAt = now
    rerankCached = value
  }
  return value
}

export interface EmbeddingSettings {
  readonly url: string
  readonly model: string
}

let embedAt = 0
let embedCached: EmbeddingSettings | undefined

/** The memory VECTOR leg's device, or undefined when unconfigured (⇒ keyword-only search). Same
 *  2s-TTL sync read of the `memory` settings row, so pointing at a device applies live. */
export function embeddingSettings(dbFile?: string): EmbeddingSettings | undefined {
  const now = Date.now()
  if (dbFile === undefined && now - embedAt < TTL_MS) return embedCached
  const value = readEmbedding(dbFile ?? DatabasePath.path())
  if (dbFile === undefined) {
    embedAt = now
    embedCached = value
  }
  return value
}

function readEmbedding(dbFile: string): EmbeddingSettings | undefined {
  try {
    const rows = readRowsSync(dbFile, "SELECT value FROM runtime_setting WHERE key = 'memory'")
    const raw = rows?.[0]?.value
    if (typeof raw !== "string") return undefined
    const parsed = JSON.parse(raw) as { embedding?: { url?: unknown; model?: unknown } }
    const url = parsed.embedding?.url
    const model = parsed.embedding?.model
    // Both are required — a half-configured device would silently produce no vectors.
    if (typeof url !== "string" || !url || typeof model !== "string" || !model) return undefined
    return { url: url.replace(/\/+$/, ""), model }
  } catch {
    return undefined // unreadable → keyword-only, never a failure
  }
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
