import type { SessionPresenceSnapshot, SessionPresenceViewer } from "@novaclaw/sdk/v2/client"

/**
 * What the person in front of THIS surface is told about everyone else in the chat.
 *
 * Pure on purpose: the whole vocabulary (alone · watching · driving · both writing · someone just
 * took over · the driver left) is decided here from a snapshot, a viewer id and a clock, so it can
 * be exercised without a server, a browser or a second tab.
 *
 * ⚠️ **Control is advisory, and the copy must never pretend otherwise.** Nothing here blocks a
 * send. A lock would turn "two people opened one chat" — an ordinary thing — into a wall, and the
 * dependability law is explicit that the UI never degrades into a dead end. So the watcher is told
 * who is driving and that they can still type; they are not told "no".
 */

/** How long after control changes hands the notice stays on screen. Long enough to read, short enough to stop being news. */
export const HANDOFF_NOTICE_SECONDS = 20

/**
 * How often this surface says "still here". Mirrors `SessionPresenceState.HEARTBEAT_SECONDS` in
 * core, which sets the budget the instance expires a viewer against (40s = three missed beats).
 */
export const HEARTBEAT_SECONDS = 10

/**
 * How long the instance keeps a viewer it has not heard from. Mirrors
 * `SessionPresenceState.VIEWER_TTL_SECONDS` in core (three missed beats).
 *
 * ⚠️ The client never applies this to a viewer ROW — the wire deliberately carries no `lastSeenAt`,
 * so a surface cannot tell a long-attached viewer from a dead one. What it bounds is how long a
 * CACHED snapshot may still be believed: the instance publishes nothing when a room's last viewer
 * dies silently (expiry is evaluated on read/write, and there is no sweeper fiber), so a store entry
 * older than this may describe someone who is gone. See `debug-presence.ts`.
 */
export const VIEWER_TTL_SECONDS = 40

/**
 * The i18n keys presence can produce, spelled out rather than typed as `string`.
 *
 * ⚠️ Not pedantry: `language.t` takes a key union, so a widened `string` here would compile the
 * renderer only if someone cast it — and a cast is exactly what lets a renamed key ship as a
 * missing line instead of a build error.
 */
export type PresenceLineKey =
  | "presence.watching"
  | "presence.driving"
  | "presence.contended.driving"
  | "presence.contended.youWriting"
  | "presence.contended.otherWriting"
  | "presence.handoff.youTookOver"
  | "presence.handoff.otherTookOver"
  | "presence.handoff.youInherited"
  | "presence.handoff.otherInherited"

export interface PresenceLine {
  readonly key: PresenceLineKey
  readonly values: Record<string, string>
}

export interface PresenceView {
  /** Everyone attached who is not this surface. Empty means there is nothing to say. */
  readonly others: ReadonlyArray<SessionPresenceViewer>
  /** Is this surface the one driving? */
  readonly driving: boolean
  /** The main line. `undefined` when this surface is alone — silence is the right copy for that. */
  readonly line?: PresenceLine
  /** Offer the take-over button only to someone who is attached and is not already driving. */
  readonly canTakeOver: boolean
}

const nameOf = (viewer: SessionPresenceViewer) => viewer.label
const join = (viewers: ReadonlyArray<SessionPresenceViewer>) => viewers.map(nameOf).join(", ")

export const presenceView = (
  snapshot: SessionPresenceSnapshot | undefined,
  selfViewerID: string | undefined,
): PresenceView => {
  const viewers = snapshot?.viewers ?? []
  const attached = viewers.some((viewer) => viewer.viewerID === selfViewerID)
  const others = viewers.filter((viewer) => viewer.viewerID !== selfViewerID)
  const driving = attached && snapshot?.control === selfViewerID
  if (others.length === 0) return { others, driving, canTakeOver: false }
  const driver = viewers.find((viewer) => viewer.viewerID === snapshot?.control)
  const driverName = driver ? nameOf(driver) : join(others)
  const contended = snapshot?.state === "contended"
  /*
   * ⚠️ The conflict copy names **who is actually writing**, and that correction came from running
   * it rather than from a test. The first version said "You and X are both writing here" to the
   * driver — but the room is contended as soon as ANY non-driver has a draft, so the driver was
   * being told they were writing when they were not, and in a three-viewer room it named the wrong
   * person. A line that misdescribes what is happening is worse than no line: it is the product
   * teaching something false at the exact moment someone is deciding whether to press send.
   */
  const writers = others.filter((viewer) => viewer.writing)
  const selfWriting = viewers.some((viewer) => viewer.viewerID === selfViewerID && viewer.writing)
  const line: PresenceLine = contended
    ? driving
      ? { key: "presence.contended.driving", values: { writers: join(writers) } }
      : selfWriting
        ? { key: "presence.contended.youWriting", values: { driver: driverName } }
        : { key: "presence.contended.otherWriting", values: { writers: join(writers), driver: driverName } }
    : driving
      ? { key: "presence.driving", values: { others: join(others) } }
      : { key: "presence.watching", values: { driver: driverName } }
  return { others, driving, line, canTakeOver: attached && !driving }
}

/**
 * The transient "control changed hands" notice.
 *
 * It is separate from {@link presenceView} because it outlives the situation that caused it: the
 * most useful case of all — *the person who was driving closed their tab, so now it is you* — is a
 * message shown to someone who is, by then, alone in the room.
 */
export const presenceHandoffNotice = (
  snapshot: SessionPresenceSnapshot | undefined,
  selfViewerID: string | undefined,
  now: number,
): PresenceLine | undefined => {
  const handoff = snapshot?.handoff
  if (!handoff) return undefined
  if (now - handoff.at > HANDOFF_NOTICE_SECONDS * 1000) return undefined
  const mine = handoff.toViewerID === selfViewerID
  if (handoff.reason === "claimed") {
    return mine
      ? { key: "presence.handoff.youTookOver", values: {} }
      : { key: "presence.handoff.otherTookOver", values: { who: handoff.toLabel } }
  }
  return mine
    ? { key: "presence.handoff.youInherited", values: { who: handoff.fromLabel ?? "" } }
    : { key: "presence.handoff.otherInherited", values: { who: handoff.toLabel } }
}

/** The Chats-row summary: how many surfaces are attached, and their names for the tooltip. */
export const presenceBadge = (snapshot: SessionPresenceSnapshot | undefined) => {
  const viewers = snapshot?.viewers ?? []
  if (viewers.length === 0) return undefined
  return { count: viewers.length, list: join(viewers), contended: snapshot?.state === "contended" }
}
