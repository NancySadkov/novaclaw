import type { SessionLike } from "./roster-live"

/** Chats with unseen output, deduplicated for badges and navigation. */
export function attentionSessionIds(input: { unseen: readonly string[] }): string[] {
  return [...new Set(input.unseen)]
}

export function isNamedAgentSession(
  session: { agent?: string | null; parentID?: string | null } | undefined,
): session is { agent: string; parentID?: string | null } {
  return !!session?.agent && !session.parentID
}

export function unseenOfficerSessions(
  sessions: readonly SessionLike[],
  agentID: string,
  unseenSessionIDs: readonly string[],
): SessionLike[] {
  const unseen = new Set(unseenSessionIDs)
  return sessions
    .filter((session) => session.agent === agentID && isNamedAgentSession(session) && unseen.has(session.id))
    .sort((a, b) =>
      (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created) || b.id.localeCompare(a.id),
    )
}
