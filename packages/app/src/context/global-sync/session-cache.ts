import type {
  PermissionV2Request,
  QuestionRequest,
  SessionStatus,
  SessionChangeDiff,
  Todo,
} from "@novaclaw/sdk/v2/client"

export const SESSION_CACHE_LIMIT = 40

type SessionCache = {
  session_status: Record<string, SessionStatus | undefined>
  session_diff: Record<string, SessionChangeDiff[] | undefined>
  todo: Record<string, Todo[] | undefined>
  permission: Record<string, PermissionV2Request[] | undefined>
  question: Record<string, QuestionRequest[] | undefined>
  /** Only on the server-session store (the tags component map); absent on the directory stores. */
  tag?: Record<string, string[] | undefined>
}

export function dropSessionCaches(store: SessionCache, sessionIDs: Iterable<string>) {
  const stale = new Set(Array.from(sessionIDs).filter(Boolean))
  if (stale.size === 0) return

  for (const sessionID of stale) {
    delete store.todo[sessionID]
    delete store.session_diff[sessionID]
    delete store.session_status[sessionID]
    delete store.permission[sessionID]
    delete store.question[sessionID]
    if (store.tag) delete store.tag[sessionID]
  }
}

export function pickSessionCacheEvictions(input: {
  seen: Set<string>
  keep: string
  limit: number
  preserve?: Iterable<string>
}) {
  const stale: string[] = []
  const keep = new Set([input.keep, ...Array.from(input.preserve ?? [])])
  if (input.seen.has(input.keep)) input.seen.delete(input.keep)
  input.seen.add(input.keep)
  for (const id of input.seen) {
    if (input.seen.size - stale.length <= input.limit) break
    if (keep.has(id)) continue
    stale.push(id)
  }
  for (const id of stale) {
    input.seen.delete(id)
  }
  return stale
}
