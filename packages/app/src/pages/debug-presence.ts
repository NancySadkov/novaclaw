import type { SessionPresenceSnapshot, SessionStatus } from "@novaclaw/sdk/v2/client"
import { isSessionWorking } from "@/context/session-working"
import { VIEWER_TTL_SECONDS } from "./session/session-presence"

/**
 * The presence column of the Debug app's `ps` table.
 *
 * AGENTS.md's organizing metaphor asks `ps` for *who is attached, who is driving, and whether the
 * session is busy*. Presence answers the first two. It deliberately answers **neither** the third:
 * `session.status` owns "busy" and is the only owner, so this module takes `busy` as an argument and
 * COMPOSES it into one line rather than reading a flag off the snapshot (there is none, and a test
 * in core pins the empty room to exactly `["state", "viewers"]`).
 *
 * Pure on purpose, like `debug-context.ts` beside it: the whole vocabulary (unattended · attached ·
 * driving · writing · busy-and-unwatched · a snapshot too old to believe · a room whose session is
 * not in this cache) is decided from a snapshot, a status and a clock.
 *
 * ## A developer surface may show raw ids. It may NOT over-claim.
 *
 * Debug is behind Developer mode, so ids and kinds are shown verbatim here where Chats shows only
 * labels. What does not change is that a row may say only what presence knows:
 *
 * - **Two windows of one browser are both "a browser window".** The only per-window value is an
 *   opaque `sessionStorage` uuid and a derived label renumbers itself on `visibilitychange`
 *   (investigated and settled). So a viewer is rendered with the label the instance holds plus its
 *   raw `viewerID` — never a manufactured "window 2".
 * - **A cached room can outlive its viewers.** The instance publishes only on report/claim/detach
 *   and runs no sweeper, so when a room's *last* viewer dies silently nothing is published and the
 *   client's copy keeps showing them until someone re-reads `GET /api/presence`. A `ps` view is
 *   precisely somebody watching, so it re-reads — and until that read lands, or once it is older
 *   than {@link VIEWER_TTL_SECONDS}, the cell says the rows are **unverified** instead of asserting
 *   attendance it cannot vouch for.
 */

/**
 * Busy, for the `ps` row — the ONE owner, reached rather than re-derived.
 *
 * ⚠️ Not `status !== "idle"`. Running it caught this: the Sessions panel's *status column* shows the
 * durable execution state when there is one (`paused`, `failed`, `drain`…), and composing busy from
 * that column made a session whose worker had EXITED read as busy. `isSessionWorking` is an
 * allowlist over the closed status set (`busy | retry` work; `idle | exited` do not) and exists
 * precisely because a `!== "idle"` test once left exited sessions spinning forever. The status
 * column and the presence column therefore read two different signals on purpose, and this is the
 * seam where that is stated.
 */
export const debugPresenceBusy = (status: SessionStatus | undefined): boolean => isSessionWorking(status)

export interface DebugPresenceViewer {
  readonly viewerID: string
  readonly label: string
  readonly kind: "human" | "agent" | "peer"
  /** Holds the driving seat. Advisory — nothing blocks a send. */
  readonly driving: boolean
  /** Reported an unsent draft on its last beat. */
  readonly writing: boolean
}

export interface DebugPresenceCell {
  readonly attached: number
  readonly viewers: ReadonlyArray<DebugPresenceViewer>
  /** From `session.status`, never from presence. Composed here so `ps` reads as one fact. */
  readonly busy: boolean
  /** True when the cached snapshot is too old (or was never re-read) to vouch for its viewer rows. */
  readonly unverified: boolean
  /** The rendered line — this string IS the column's DOM text. */
  readonly text: string
  /** Tooltip: the raw viewer ids, which Chats never shows and a developer surface may. */
  readonly title: string
}

const TTL_MS = VIEWER_TTL_SECONDS * 1000

const formatAge = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 90) return `${seconds}s ago`
  return `${Math.round(seconds / 60)}m ago`
}

const describeViewer = (viewer: DebugPresenceViewer) => {
  const flags = [viewer.driving ? "driving" : undefined, viewer.writing ? "writing" : undefined].filter(
    (flag): flag is string => flag !== undefined,
  )
  return flags.length === 0 ? viewer.label : `${viewer.label} (${flags.join(", ")})`
}

export const debugPresenceCell = (input: {
  readonly snapshot: SessionPresenceSnapshot | undefined
  readonly busy: boolean
  /** When `GET /api/presence` last answered for this instance. `undefined` = not yet. */
  readonly readAt: number | undefined
  readonly now: number
}): DebugPresenceCell => {
  const viewers: DebugPresenceViewer[] = (input.snapshot?.viewers ?? []).map((viewer) => ({
    viewerID: viewer.viewerID,
    label: viewer.label,
    kind: viewer.kind,
    driving: viewer.viewerID === input.snapshot?.control,
    writing: viewer.writing,
  }))
  // Staleness is only ever a claim about viewers that are LISTED: an empty cell over-claims nothing,
  // so marking it unverified would be noise on every idle row in the table.
  const unverified =
    viewers.length > 0 && (input.readAt === undefined || input.now - input.readAt > TTL_MS)
  const parts = [
    viewers.length === 0
      ? "unattended"
      : `${viewers.length} attached · ${viewers.map(describeViewer).join(", ")}`,
  ]
  if (input.busy) parts.push("busy")
  if (unverified) {
    parts.push(input.readAt === undefined ? "unverified (not read yet)" : `unverified (read ${formatAge(input.now - input.readAt)})`)
  }
  return {
    attached: viewers.length,
    viewers,
    busy: input.busy,
    unverified,
    text: parts.join(" · "),
    title: viewers.map((viewer) => `${viewer.viewerID} (${viewer.kind})`).join(" · "),
  }
}

export interface DebugPresenceOrphan {
  readonly sessionID: string
  readonly attached: number
}

/**
 * Rooms whose session this client does not list.
 *
 * Real, not hypothetical: a room is keyed by session id and is collected by attendance alone, so a
 * session deleted (or simply never cached by this client) while a surface was attached leaves a room
 * behind. The `ps` table is driven by the session list, so those rooms would be invisible — and a
 * diagnostic surface silently dropping state is the thing it exists to prevent. They are reported
 * beneath the table rather than injected as fake session rows.
 */
export const debugPresenceOrphans = (
  presence: Readonly<Record<string, SessionPresenceSnapshot | undefined>>,
  known: ReadonlySet<string>,
): DebugPresenceOrphan[] =>
  Object.entries(presence)
    .filter(([sessionID, snapshot]) => !known.has(sessionID) && (snapshot?.viewers.length ?? 0) > 0)
    .map(([sessionID, snapshot]) => ({ sessionID, attached: snapshot!.viewers.length }))
    .sort((a, b) => (a.sessionID < b.sessionID ? -1 : a.sessionID > b.sessionID ? 1 : 0))

/**
 * ⚠️ Takes `unverified` for the same reason the cells do, and running it is what showed why: while
 * presence reads were failing, the table's rows said "unverified" and this line went on asserting
 * "1 attached" beneath them. It is the same cached map, so it inherits the same doubt.
 */
export const debugPresenceOrphanText = (
  orphans: ReadonlyArray<DebugPresenceOrphan>,
  unverified = false,
): string | undefined => {
  if (orphans.length === 0) return undefined
  const rooms = orphans.map((orphan) => `${orphan.sessionID} (${orphan.attached} attached)`).join(", ")
  const line = `presence for ${orphans.length} session${orphans.length === 1 ? "" : "s"} not listed above: ${rooms}`
  return unverified ? `${line} · unverified` : line
}
