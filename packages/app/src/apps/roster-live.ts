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
import { formatTokensPerSecond as formatTokenRate } from "@/utils/token-rate"

/** The session fields the roster needs. A structural subset, so the wire type can grow freely. */
export interface SessionLike {
  readonly id: string
  readonly parentID?: string | undefined
  readonly agent?: string | undefined
  readonly type?: "interactive" | "sub-agent" | "auto-prompting" | "goal-oriented" | undefined
  readonly title?: string | undefined
  readonly tokens?:
    | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
    | undefined
  readonly time: {
    readonly created: number
    readonly updated?: number | undefined
    readonly archived?: number | undefined
  }
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

/**
 * WHICH chat "Clear chat" acts on — which is not always the one `chatFor` would hand a colleague.
 *
 * 🔴 **`chatFor` alone told the owner there was nothing to clear while the transcript was on screen**
 * (2026-09-03). Measured on the prod instance: colleague `umbris` had four root chats and ALL FOUR
 * carried a `time_archived`, including the one in the open tab — 19 messages, archived 2026-08-27
 * 23:13, still receiving messages until 2026-09-01, because refusing work on a filed chat only
 * landed in `c5cf172c9` on 2026-09-03. `chatFor` excludes archived rows on purpose, so it answered
 * "no chat", the toast said *"There is no chat to clear yet"*, and the chat the user was looking at
 * stayed exactly where it was — unclearable, and by then unable to take a message either.
 *
 * ⚠️ **`chatFor` is still right, and is deliberately NOT relaxed.** Its exclusion is what stops a
 * colleague being handed back the conversation the user just cleared. The two questions are simply
 * different: `chatFor` asks *which chat is this colleague's now*, and this asks *which transcript is
 * the user asking to be rid of*. Answering the second with the first is what produced a dead end.
 *
 * The order is the user's own view of it:
 *   1. the chat the ROUTE names, when it is this colleague's — they are looking at it, so it is the
 *      one they mean, archived or not;
 *   2. otherwise the colleague's live chat, exactly as `chatFor` picks it;
 *   3. otherwise its most recent archived root — from Contacts there is no route to go on, and
 *      "nothing to clear" is false whenever a transcript exists at all.
 *
 * `undefined` therefore means what the toast says: this colleague has never had a chat.
 */
export const chatToClear = (
  sessions: readonly SessionLike[],
  agentID: string,
  routePath: string,
): SessionLike | undefined => {
  let routed: SessionLike | undefined
  let archived: SessionLike | undefined
  for (const session of sessions) {
    if (session.agent !== agentID || !isRoot(session)) continue
    // A path segment match, not a substring of some other id: ids are opaque, so anchor on the
    // separators the route actually puts around them.
    if (routePath.split(/[/?&=]/).includes(session.id)) routed = session
    if (session.time.archived === undefined) continue
    if (archived === undefined || touchedAt(session) > touchedAt(archived)) archived = session
  }
  return routed ?? chatFor(sessions, agentID) ?? archived
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

/** Every worker that still belongs in the officer's current worker set, including nested workers. */
export const workersOf = (
  sessions: readonly SessionLike[],
  rootID: string,
  stateOf?: (sessionID: string) => { readonly lifecycle?: string; readonly execution?: ExecutionState },
): readonly SessionLike[] => {
  const thread = threadOf(sessions, rootID)
  const byID = new Map(thread.map((session) => [session.id, session] as const))
  const terminal = (sessionID: string) => {
    const state = stateOf?.(sessionID)
    return (
      state?.lifecycle === "exited" ||
      state?.execution === "settled" ||
      state?.execution === "failed" ||
      state?.execution === "interrupted"
    )
  }
  return thread.filter((session) => {
    if (session.id === rootID || session.type !== "sub-agent") return false
    // A historical child stays in the transcript, but not in the CURRENT worker set. Interrupted
    // and failed attempts cannot move without replacement; a settled/exited child has returned.
    // Prune descendants with their terminal ancestor too, so a dead branch cannot leave orphans.
    let current: SessionLike | undefined = session
    while (current !== undefined && current.id !== rootID) {
      if (terminal(current.id)) return false
      current = current.parentID ? byID.get(current.parentID) : undefined
    }
    return current?.id === rootID
  })
}

/** Live generated-token rate for an officer and every worker below that officer's chat. */
export const threadRate = (
  sessions: readonly SessionLike[],
  rootID: string,
  rateOf: (sessionID: string) => number | undefined,
): number | undefined => {
  let total = 0
  for (const session of threadOf(sessions, rootID)) total += rateOf(session.id) ?? 0
  return total > 0 ? total : undefined
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
 * 🔴 **Read from the colleague's STATUS component, not from a chat title** (owner, 2026-08-28:
 * *"we no longer have 1st class sessions and have no session titles. Instead each agent has a single
 * session as its component, and every few hours if agent did some work we update the current task
 * name + status"*). The instance derives that line from the colleague's newest work and rewrites it
 * as the work moves on; a title was written once, from the first thing said, and never revisited.
 *
 * ⚠️ The title fallback is KEPT, deliberately and temporarily. A status line appears only after the
 * first sweep, so an instance that has been running for five minutes has none — and a roster that
 * showed nothing until then would look broken on exactly the day this shipped. The fallback carries
 * its own guard below.
 *
 * ⚠️ **A chat titled after the colleague is not a task** (owner, 2026-08-27: *"Nova has its name
 * duplicated as current task name"*). `startChat` seeds a new chat's title with the colleague's own
 * name, so until the first reply renames it the row printed the name twice — once as the name and
 * once as what it was supposedly working on. That is not a task, it is an echo. Compared
 * case-insensitively and trimmed, because the display name may be capitalised differently from the
 * row's own rendering of it.
 */
export const rosterTask = (input: {
  readonly status: { readonly task: string } | undefined
  readonly title: string | undefined
  readonly colleagueName: string
}): string | undefined => {
  // The component wins whenever it has anything to say. It is never an echo of the name — it is
  // derived from what the colleague DID, not from what the chat was called.
  const task = input.status?.task?.trim()
  if (task) return task
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
  return formatTokenRate(perMinute === undefined ? undefined : perMinute / 60)
}

/**
 * WHAT A COLLEAGUE IS DOING — three words, from the scheduler's own answer.
 *
 * 🔴 Deliberately coarse (owner, 2026-08-27: *"the status is meant for our thread scheduler … no
 * need to over engineer"*). The question is whether the model is running, not which internal phase
 * it is in: `session_working` is already the ONE answer to "is it working" — `server-session.ts`
 * says so where it refuses to let presence carry a second busy flag — and a roster that disagreed
 * with the Home hero about the same session would be the defect that note prevents.
 *
 * `retry` is the reachability case. A provider the instance cannot reach is retrying, and the row
 * says **Error** rather than leaving a colleague looking idle while nothing can run.
 *
 * ⚠️ A first draft read `busy.timing.phases` to separate "waiting on a tool" from "thinking". It was
 * deleted: richer telemetry belongs to a world where model servers are a reliable standard, and
 * until then a status with more resolution than the source has is decoration.
 */
export type ExecutionState = "starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled"

export type TerminalAttention = "complete" | "recovery"

export const isRecoveryExecutionState = (state: ExecutionState | undefined): boolean =>
  state === "paused" || state === "failed" || state === "interrupted"

/**
 * Turn a terminal lifecycle transition plus its durable execution row into one user-facing fact.
 *
 * `idle` says only that the scheduler stopped running this session. It deliberately does NOT say
 * whether the turn settled or was parked after an unsafe/failed attempt; the execution ledger owns
 * that distinction. `exited`, by contrast, follows the durable Completed event and is itself the
 * terminal result for an autonomous thread.
 *
 * An early runner `idle` can arrive while post-run maintenance is still inside a busy lease. It is
 * ignored here; the host publishes the same lifecycle transition after settling the lease, which is
 * the only point at which completion attention is truthful.
 */
export const terminalAttention = (input: {
  readonly lifecycle: string | undefined
  readonly execution: ExecutionState | undefined
}): TerminalAttention | undefined => {
  if (input.lifecycle === "exited") return "complete"
  if (input.lifecycle !== "idle") return undefined
  if (input.execution === "settled") return "complete"
  if (isRecoveryExecutionState(input.execution)) return "recovery"
  return undefined
}

export type RosterState = "idle" | "working" | "error" | "paused"

export const rosterState = (input: {
  readonly status: { readonly type: string } | undefined
  readonly working: boolean
  readonly execution?: { readonly state: ExecutionState } | undefined
}): RosterState => {
  if (input.status?.type === "retry") return "error"
  if (input.working) return "working"
  if (isRecoveryExecutionState(input.execution?.state)) return "paused"
  return "idle"
}
