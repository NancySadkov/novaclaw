import type { ServerConnection } from "@/context/server"

export const SESSION_TABS_REMOVED_EVENT = "novaclaw:session-tabs-removed"

export type SessionTabsRemovedDetail = {
  server?: ServerConnection.Key
  directory: string
  sessionIDs: string[]
}

export function notifySessionTabsRemoved(input: SessionTabsRemovedDetail) {
  window.dispatchEvent(new CustomEvent(SESSION_TABS_REMOVED_EVENT, { detail: input }))
}

export const SESSION_AGENT_CHATS_EVENT = "novaclaw:session-agent-chats"

/** One row per session the shell knows about — the shape `tabs.followAgentChats` decides from. */
export type SessionAgentChatRow = {
  id: string
  agent?: string
  parentID?: string
  archived: boolean
}

export type SessionAgentChatsDetail = {
  server?: ServerConnection.Key
  rows: SessionAgentChatRow[]
}

/**
 * A colleague's live chat may have changed — re-evaluate which chat each colleague's tab points at.
 *
 * 🔴 Raised from the EVENT STREAM, on every `session.created`/`updated`/`deleted`, because the
 * archive and its successor are two events and either may arrive first. Until 2026-09-03 the only
 * caller of `followAgentChats` was the colleague dialog's post-save fetch: a one-shot that races the
 * archive it is trying to observe, and that never fires at all when the reassignment comes from
 * anywhere else. Reported from a live build: change a colleague's folder, send a message, and the
 * prompt is refused with *"This conversation has been filed and does not take new messages"* —
 * the server naming a successor the client was still not pointing at.
 */
export function notifySessionAgentChats(input: SessionAgentChatsDetail) {
  if (input.rows.length === 0) return
  window.dispatchEvent(new CustomEvent(SESSION_AGENT_CHATS_EVENT, { detail: input }))
}

export function readSessionAgentChatsDetail(event: Event): SessionAgentChatsDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined
  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object" || !("rows" in detail)) return undefined
  if (!Array.isArray(detail.rows)) return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined
  const rows = detail.rows.filter(
    (row): row is SessionAgentChatRow =>
      !!row && typeof row === "object" && typeof row.id === "string" && typeof row.archived === "boolean",
  )
  if (rows.length === 0) return undefined
  return {
    server:
      "server" in detail && typeof detail.server === "string" ? (detail.server as ServerConnection.Key) : undefined,
    rows,
  }
}

export function readSessionTabsRemovedDetail(event: Event): SessionTabsRemovedDetail | undefined {
  if (!(event instanceof CustomEvent)) return undefined

  const detail: unknown = event.detail
  if (!detail || typeof detail !== "object") return undefined
  if (!("directory" in detail)) return undefined
  if (!("sessionIDs" in detail)) return undefined
  if (typeof detail.directory !== "string") return undefined
  if (!Array.isArray(detail.sessionIDs)) return undefined
  if ("server" in detail && detail.server !== undefined && typeof detail.server !== "string") return undefined

  const sessionIDs = detail.sessionIDs.filter((id): id is string => typeof id === "string")
  if (sessionIDs.length === 0) return undefined

  return {
    server:
      "server" in detail && typeof detail.server === "string" ? (detail.server as ServerConnection.Key) : undefined,
    directory: detail.directory,
    sessionIDs,
  }
}
