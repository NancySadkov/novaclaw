/**
 * Session-bound references for model-facing graph operations.
 *
 * The graph engine owns durable storage ids. They are useful inside the engine and in diagnostics,
 * but they are not a model API: a model should carry a handle returned by search/remember into the
 * next kb operation. Handles are deliberately in-memory and bounded. A restart, session change, or
 * eviction therefore makes a handle expire and the tool can ask the model to search again rather than
 * accepting an id copied from an untrusted prompt.
 */
import { randomBytes } from "node:crypto"

export const HANDLE_PREFIX = "ref_"
export const MAX_HANDLES_PER_SESSION = 2_048
export const MAX_SESSIONS = 256

export type ReferenceHandle = string

export interface ReferenceStore {
  readonly issue: (sessionID: string, storageID: string) => ReferenceHandle
  readonly resolve: (sessionID: string, handle: string) => string | undefined
  readonly forgetSession: (sessionID: string) => void
  readonly sessionSize: (sessionID: string) => number
  readonly size: () => number
}

export const isHandle = (value: unknown): value is ReferenceHandle =>
  typeof value === "string" && /^ref_[A-Za-z0-9_-]+$/.test(value)

const newToken = (): string => randomBytes(18).toString("base64url")

/** Make a bounded store. The limits are part of the contract, not a caller convention. */
export const make = (
  options: {
    readonly maxHandlesPerSession?: number
    readonly maxSessions?: number
  } = {},
): ReferenceStore => {
  const maxHandlesPerSession = Math.max(1, options.maxHandlesPerSession ?? MAX_HANDLES_PER_SESSION)
  const maxSessions = Math.max(1, options.maxSessions ?? MAX_SESSIONS)
  const sessions = new Map<string, Map<ReferenceHandle, string>>()

  const evictSessions = () => {
    while (sessions.size > maxSessions) {
      const oldest = sessions.keys().next().value as string | undefined
      if (oldest === undefined) return
      sessions.delete(oldest)
    }
  }

  const issue = (sessionID: string, storageID: string): ReferenceHandle => {
    let handles = sessions.get(sessionID)
    if (handles === undefined) {
      handles = new Map()
      sessions.set(sessionID, handles)
      evictSessions()
    }

    // Keep the handle stable while it is live. A chain such as remember → relate → neighbors should
    // not make the model translate a new reference for the same graph node on every response.
    for (const [handle, currentID] of handles) {
      if (currentID === storageID) return handle
    }

    let handle = `${HANDLE_PREFIX}${newToken()}`
    while (handles.has(handle)) handle = `${HANDLE_PREFIX}${newToken()}`
    handles.set(handle, storageID)
    while (handles.size > maxHandlesPerSession) {
      const oldest = handles.keys().next().value as ReferenceHandle | undefined
      if (oldest === undefined) break
      handles.delete(oldest)
    }
    return handle
  }

  return {
    issue,
    resolve: (sessionID, handle) => (isHandle(handle) ? sessions.get(sessionID)?.get(handle) : undefined),
    forgetSession: (sessionID) => {
      sessions.delete(sessionID)
    },
    sessionSize: (sessionID) => sessions.get(sessionID)?.size ?? 0,
    size: () => [...sessions.values()].reduce((total, handles) => total + handles.size, 0),
  }
}
