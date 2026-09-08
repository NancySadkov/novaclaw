export * as ServerToken from "./server-token"

// P2P instances: the instance's INCOMING API token (the Basic-auth password every HTTP surface
// gates on). Resolution order: the NOVACLAW_SERVER_PASSWORD env (machine escape hatch, wins) →
// the settings store's `server.password` (set from Settings → Instances). Read synchronously
// with a short TTL cache so a token set in the UI applies live (~2s) without threading a store
// service through every auth middleware — the same boot-time sync-read pattern offline.ts uses.

import { readRowsSync } from "#sqlite"
import { DatabasePath } from "./database/db-path"

const TTL_MS = 2_000
let cachedAt = 0
let cached: string | undefined

/** The store-configured incoming token, or undefined when none is set. */
export function storedPassword(dbFile?: string): string | undefined {
  const now = Date.now()
  if (dbFile === undefined && now - cachedAt < TTL_MS) return cached
  const value = readStored(dbFile ?? DatabasePath.path())
  if (dbFile === undefined) {
    cachedAt = now
    cached = value
  }
  return value
}

/** Drop the cache (tests; immediate re-read after a settings write). */
export function bust() {
  cachedAt = 0
  cached = undefined
}

function readStored(dbFile: string): string | undefined {
  const rows = readRowsSync(dbFile, "SELECT value FROM runtime_setting WHERE key = 'server'")
  const raw = rows?.[0]?.value
  if (typeof raw !== "string") return undefined
  try {
    const parsed = JSON.parse(raw) as { password?: unknown }
    return typeof parsed.password === "string" && parsed.password.length > 0 ? parsed.password : undefined
  } catch {
    return undefined
  }
}
