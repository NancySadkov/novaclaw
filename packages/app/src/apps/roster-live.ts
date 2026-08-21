// What the roster shows about a colleague's WORK — the half it inherits from the chat list it
// replaces (owner, 2026-08-21; AGENTS.md → the structural metaphor).
//
// 🔴 **One chat per colleague, not a list.** The chat list grew forever because a conversation was
// the unit; under the roster the COLLEAGUE is the unit and its conversation is a property of it. So
// this module answers "which chat is Theron's" rather than "what chats exist", and everything on the
// row — the task it is on, what it has spent, how fast it is going — hangs off that one answer.
//
// Pure, so every rule below is testable: which session counts as the colleague's, how sub-agent
// threads roll up into its totals, and what is shown when there is nothing to show yet.

import { tokenTotals, type TokenTotals } from "@/pages/home-session-meta"

/** The session fields the roster needs. A structural subset, so the wire type can grow freely. */
export interface SessionLike {
  readonly id: string
  readonly parentID?: string | undefined
  readonly agent?: string | undefined
  readonly title?: string | undefined
  readonly tokens?:
    | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    | undefined
  readonly time: { readonly created: number; readonly updated?: number | undefined; readonly archived?: number | undefined }
}

/** What one colleague's row knows about its work. */
export interface RosterLive {
  /** The colleague's chat, if it has one yet. */
  readonly sessionID: string | undefined
  /** What it is working on — the chat's auto-generated title, reused verbatim rather than a second
   *  title algorithm growing beside the first. `undefined` before the first response names it. */
  readonly title: string | undefined
  /** Tokens this colleague has PRODUCED across its chat and that chat's sub-agent threads. The
   *  nameless staff spend on their officer's behalf, so their spend is the officer's. */
  readonly tokens: TokenTotals
  /** True while its chat is the most recently touched — used only for ordering, never as a status. */
  readonly updatedAt: number | undefined
}

const isRoot = (session: SessionLike) => session.parentID === undefined || session.parentID === ""
const touchedAt = (session: SessionLike) => session.time.updated ?? session.time.created

/**
 * The ONE chat that belongs to a colleague.
 *
 * ⚠️ An ARCHIVED chat never wins, even when it is the most recent. "Clear chat" archives the old one
 * and starts fresh, so preferring recency alone would hand the colleague back the conversation the
 * user just cleared — the single most confusing thing this function could do.
 *
 * Among live candidates the most recently touched wins. More than one root chat for an agent is not
 * supposed to happen once creation goes through the roster, but it can exist in a tree that predates
 * it, and picking deterministically beats picking arbitrarily.
 */
export const chatFor = (sessions: readonly SessionLike[], agentID: string): SessionLike | undefined => {
  let best: SessionLike | undefined
  for (const session of sessions) {
    if (session.agent !== agentID || !isRoot(session)) continue
    if (session.time.archived !== undefined) continue
    if (best === undefined || touchedAt(session) > touchedAt(best)) best = session
  }
  return best
}

/** A chat and every thread spawned under it, transitively — the unit token spend is measured over. */
export const threadOf = (sessions: readonly SessionLike[], rootID: string): readonly SessionLike[] => {
  const byParent = new Map<string, SessionLike[]>()
  const byID = new Map<string, SessionLike>()
  for (const session of sessions) {
    byID.set(session.id, session)
    const parent = session.parentID
    if (parent === undefined || parent === "") continue
    const list = byParent.get(parent) ?? []
    list.push(session)
    byParent.set(parent, list)
  }
  const root = byID.get(rootID)
  if (root === undefined) return []
  const out: SessionLike[] = [root]
  // Breadth-first with a seen set: a cycle in the parent chain would otherwise hang the roster,
  // and the roster is the first screen a user sees.
  const seen = new Set([rootID])
  for (let index = 0; index < out.length; index++) {
    for (const child of byParent.get(out[index]!.id) ?? []) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
    }
  }
  return out
}

export const liveFor = (sessions: readonly SessionLike[], agentID: string): RosterLive => {
  const chat = chatFor(sessions, agentID)
  if (chat === undefined)
    return { sessionID: undefined, title: undefined, tokens: tokenTotals([]), updatedAt: undefined }
  const thread = threadOf(sessions, chat.id)
  return {
    sessionID: chat.id,
    title: chat.title?.trim() || undefined,
    tokens: tokenTotals(thread),
    updatedAt: touchedAt(chat),
  }
}
