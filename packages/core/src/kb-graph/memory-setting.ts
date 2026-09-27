export * as MemorySetting from "./memory-setting"

// The lay Memory ON/OFF privacy switch. Two gates decide whether memory does anything:
//   • NOVACLAW_WORLD_MEMORY (env) — CAPABILITY: can the sole RAG engine open at all.
//   • memory.enabled (setting)  — the USER's privacy choice. When off, the RUNTIME flows
//     stand down (auto-recall, auto-extraction, background retention) so nothing is
//     recalled, recorded, or persisted — but the MANAGEMENT surface (the /memory viewer + export/clear)
//     stays live so the user can still see and clear what's already stored.
//
// 🔴 OPT-IN, since 2026-09-27, and the reason is a MEASUREMENT rather than a preference. The engine
// is LadybugDB compiled to Wasm, and `WasmMemory.open` costs ~1.3 GB resident for a store holding
// ZERO memories — 871 MB external, 433 MB of that ArrayBuffer, JS heap under 15 MB. It is a FIXED
// arena allocated at open, not a function of the data, and Wasm linear memory has no shrink, so
// `close()` releases none of it. A live instance sat at 2.8 GB doing nothing and reached 15.6 GB after
// work, holding enough commit to take a 32 GB box to 100 % — which is what reaped the user's browser
// and editor and wall-clock-killed the `core` gate. A default that costs 1.3 GB before a single memory
// exists is not a default anyone should opt into by accident.
//
// ⚠️ **Opt-in inverts this file's fail-open rule, so the two cases are now kept apart on purpose.**
// It used to read "any read problem defaults to ENABLED, so memory only stops when EXPLICITLY turned
// off" — correct while the default was on, and now actively harmful, because a read failure would
// silently kill a feature the user had chosen. So:
//   • the row is ABSENT, or carries no `enabled` flag → the user never chose → **OFF** (opt-in);
//   • the read THREW → we do not know what they chose → **ON** (fail-open, unchanged).
// Collapsing these two is how a database that cannot be read becomes a silently broken product.
//
// Read synchronously with a short TTL cache from the settings store (`runtime_setting` key `memory`) —
// the same boot-time sync-read `server-token.ts` uses — so a toggle in Settings applies live (~2s)
// without threading a store service through the runner/tool/consolidation gates.

import { readRowsSync } from "#sqlite"
import { DatabasePath } from "../database/db-path"

const TTL_MS = 2_000
let cachedAt = 0
let cached = false

/** Whether the user has memory turned on. OPT-IN: off until they say otherwise. */
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
  cached = false
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
  let raw: unknown
  try {
    const rows = readRowsSync(dbFile, "SELECT value FROM runtime_setting WHERE key = 'memory'")
    raw = rows?.[0]?.value
  } catch {
    // We do not know what the user chose, and that is not the same as them never having chosen.
    // Fail OPEN, unchanged from before: a database we cannot read must not silently switch a feature
    // off. Only an ABSENT answer opts in.
    return true
  }
  if (typeof raw !== "string") return false // never set → opt-in default, memory off
  try {
    const parsed = JSON.parse(raw) as { enabled?: unknown }
    // Only an explicit `true` turns it on. `{}`, `{"enabled":null}` and a missing flag all mean the
    // user never chose, which under opt-in means off.
    return parsed.enabled === true
  } catch {
    // Unparseable is a CORRUPT row, not an absent one: the user did set something here and we cannot
    // read it, so fail open rather than decide for them.
    return true
  }
}
