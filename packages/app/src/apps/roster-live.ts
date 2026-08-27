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

/** One minute of a colleague's output, as the wire carries it. */
export interface UsageMinute {
  readonly minute: number
  readonly generated: number
}

/**
 * Tokens per minute over the last `window` minutes, or `undefined` when the colleague produced
 * nothing in that window.
 *
 * 🔴 **`undefined`, never `0`.** The series is sparse on purpose — a minute with no output has no
 * row — so a window with no rows means "not working", which the roster says in words rather than by
 * printing a zero rate. A "0/min" badge beside a colleague reads as a measurement of its speed, and
 * the thing it would actually be measuring is our decision to render it.
 *
 * ⚠️ The divisor is the WINDOW, not the number of rows present. Dividing by rows would answer "how
 * fast when it was working", which flatters every colleague to roughly the same number; dividing by
 * the window answers "how much of the last ten minutes was work", which is what a rate on a roster
 * is for.
 */
export const ratePerMinute = (
  series: readonly UsageMinute[],
  input: { readonly now: number; readonly window: number },
): number | undefined => {
  if (input.window <= 0) return undefined
  const nowMinute = Math.floor(input.now / 60_000)
  const oldest = nowMinute - input.window + 1
  let total = 0
  for (const entry of series) if (entry.minute >= oldest && entry.minute <= nowMinute) total += entry.generated
  if (total <= 0) return undefined
  return total / input.window
}

/**
 * The rate as the row prints it.
 *
 * 🔴 **A rate below one token per minute renders as `<1`, never as `0`.** Rounding is where the
 * sparse-series rule quietly dies: a real turn that produced two tokens over a ten-minute window is
 * 0.2/min, and `Math.round` turns that into the exact "0/min" badge the series went out of its way
 * never to store. Measured on a live turn 2026-08-21 — the first render of this badge said 0 for a
 * colleague that had just answered.
 */
export const formatRate = (perMinute: number): string => {
  if (perMinute >= 10) return String(Math.round(perMinute))
  if (perMinute >= 1) return perMinute.toFixed(1).replace(/\.0$/, "")
  return "<1"
}


/**
 * The colleague's CURRENT TASK, or nothing.
 *
 * 🔴 **A chat titled after the colleague is not a task** (owner, 2026-08-27: *"Nova has its name
 * duplicated as current task name"*). `startChat` seeds a new chat's title with the colleague's own
 * name, so until the first reply renames it the row printed the name twice — once as the name and
 * once as what it was supposedly working on. That is not a task, it is an echo.
 *
 * ⚠️ Compared case-insensitively and trimmed, because the echo comes from a display name that may be
 * capitalised differently from the row's own rendering of it.
 */
export const rosterTask = (input: {
  readonly title: string | undefined
  readonly colleagueName: string
}): string | undefined => {
  const title = input.title?.trim()
  if (!title) return undefined
  return title.toLowerCase() === input.colleagueName.trim().toLowerCase() ? undefined : title
}

/**
 * Tokens per SECOND, from the same per-minute series the rate badge already reads.
 *
 * ⚠️ Derived rather than measured separately: one series, two presentations, so the two can never
 * disagree about how fast a colleague is going. Returns `undefined` for a silent window exactly as
 * `ratePerMinute` does — a zero would read as a measurement of the colleague's speed rather than of
 * our decision to render it.
 */
export const formatTokensPerSecond = (perMinute: number | undefined): string | undefined => {
  if (perMinute === undefined || perMinute <= 0) return undefined
  const perSecond = perMinute / 60
  if (perSecond >= 10) return String(Math.round(perSecond))
  if (perSecond >= 0.1) return perSecond.toFixed(1).replace(/\.0$/, "")
  return "<0.1"
}
