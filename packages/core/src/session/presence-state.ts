export * as SessionPresenceState from "./presence-state"

import type { SessionPresence } from "@novaclaw/schema/session-presence"

/**
 * The presence state machine, as a PURE reducer over one session's attached viewers.
 *
 * Everything that decides *who is driving*, *when a viewer has gone*, and *whether two surfaces are
 * reaching for one chat* lives here, with `now` passed in — so the whole vocabulary (idle, two
 * viewers, a handoff, a conflict, a stale tab) is unit-testable without a clock, a server, or a
 * browser. `presence.ts` is the thin Effect service that owns the map and publishes the events.
 *
 * ## Expiry, in human units (AGENTS.md principle 12c)
 *
 * A client attached to a session beats every {@link HEARTBEAT_SECONDS} seconds; a viewer that has
 * not been heard from for {@link VIEWER_TTL_SECONDS} seconds is **gone** and is pruned. Forty
 * seconds is *three consecutive missed beats*: long enough to ride out a network stall or the
 * instance's own auto-restart without a viewer flickering in and out of the list, short enough that
 * a person who closes one of their two tabs sees the other tab tell the truth while they still
 * remember doing it. The common cases do not wait for it at all — a tab that is closed, navigated
 * away, or hidden detaches explicitly, so the timeout is only the backstop for a surface that
 * vanished without saying so (a killed browser, a dropped link, a peer that went dark).
 *
 * ## Control never goes vacant
 *
 * When the driver leaves, control **succeeds** to the longest-attached remaining viewer rather than
 * becoming empty. A chat nobody is allowed to drive is exactly the dead end AGENTS.md forbids, and
 * an empty control slot would need a person to notice a button before the chat worked again.
 */

/** How often an attached client says "still here". The client cadence; {@link VIEWER_TTL_SECONDS} is the budget. */
export const HEARTBEAT_SECONDS = 10

/** A viewer unheard-from for this long is gone. Three missed beats — see the note above. */
export const VIEWER_TTL_SECONDS = 40

const TTL_MS = VIEWER_TTL_SECONDS * 1000

/** A viewer as the instance holds it. The wire shape ({@link SessionPresence.Viewer}) is derived from this. */
export interface Record {
  readonly viewerID: string
  readonly kind: SessionPresence.ViewerKind
  readonly label: string
  readonly attachedAt: number
  readonly lastSeenAt: number
  /** Reported by the client on each beat: does this surface hold an unsent draft? */
  readonly writing: boolean
}

/** One session's presence. Immutable — every operation returns a fresh room. */
export interface Room {
  readonly records: ReadonlyArray<Record>
  readonly control?: string
  readonly handoff?: SessionPresence.Handoff
}

export const empty: Room = { records: [] }

/** True when nothing is attached and nothing is remembered — the service drops such rooms. */
export const isEmpty = (room: Room) => room.records.length === 0

export interface ReportInput {
  readonly viewerID: string
  readonly kind: SessionPresence.ViewerKind
  readonly label: string
  readonly writing?: boolean
}

/** Oldest attachment first — this ordering IS the succession order, so it must be total. */
const bySeniority = (a: Record, b: Record) =>
  a.attachedAt - b.attachedAt || (a.viewerID < b.viewerID ? -1 : a.viewerID > b.viewerID ? 1 : 0)

/**
 * Prune the gone, then make sure someone is driving.
 *
 * ⚠️ Pruning happens BEFORE control is resolved, and expired rows are dropped rather than
 * remembered: a room that empties out forgets its handoff too. Otherwise a viewer arriving hours
 * later would be told "so-and-so left, you're driving now" about a departure nobody was present for.
 */
const settle = (room: Room, now: number): Room => {
  const live = room.records.filter((record) => now - record.lastSeenAt <= TTL_MS).sort(bySeniority)
  if (live.length === 0) return { records: [] }
  if (room.control !== undefined && live.some((record) => record.viewerID === room.control)) {
    return { records: live, control: room.control, ...(room.handoff ? { handoff: room.handoff } : {}) }
  }
  const successor = live[0]!
  const departed = room.records.find((record) => record.viewerID === room.control)
  // First-ever acquisition announces nothing: there is no one it was taken from.
  if (room.control === undefined) return { records: live, control: successor.viewerID }
  return {
    records: live,
    control: successor.viewerID,
    handoff: {
      fromViewerID: room.control,
      ...(departed ? { fromLabel: departed.label } : {}),
      toViewerID: successor.viewerID,
      toLabel: successor.label,
      at: now,
      reason: "succession",
    },
  }
}

/** Attach a viewer, or refresh one that is already here. Idempotent — a beat and an attach are one call. */
export const report = (room: Room, input: ReportInput, now: number): Room => {
  const existing = room.records.find((record) => record.viewerID === input.viewerID)
  const next: Record = {
    viewerID: input.viewerID,
    kind: input.kind,
    label: input.label,
    attachedAt: existing?.attachedAt ?? now,
    lastSeenAt: now,
    writing: input.writing ?? false,
  }
  const records = existing
    ? room.records.map((record) => (record.viewerID === input.viewerID ? next : record))
    : [...room.records, next]
  return settle({ ...room, records }, now)
}

/**
 * A surface saying goodbye — a closed tab, a navigation away, a peer hanging up.
 *
 * ⚠️ It **backdates** the leaver rather than deleting it outright, so that `settle` still sees the
 * row it is about to prune and can name who left in the succession notice. Deleting it produced a
 * handoff card that said control had passed *from* nobody.
 */
export const detach = (room: Room, viewerID: string, now: number): Room =>
  settle(
    {
      ...room,
      records: room.records.map((record) =>
        record.viewerID === viewerID ? { ...record, lastSeenAt: now - TTL_MS - 1 } : record,
      ),
    },
    now,
  )

/**
 * Take over the driving seat. A deliberate handoff, and the ONLY way control moves between two
 * viewers that are both still here.
 *
 * A claim from a viewer that is not attached is ignored rather than rejected: it means the claimer
 * already timed out, and the honest answer is the room as it stands, not an error.
 */
export const claim = (room: Room, viewerID: string, now: number): Room => {
  const settled = settle(room, now)
  const claimer = settled.records.find((record) => record.viewerID === viewerID)
  if (!claimer) return settled
  if (settled.control === viewerID) return settled
  const previous = settled.records.find((record) => record.viewerID === settled.control)
  return {
    records: settled.records,
    control: viewerID,
    handoff: {
      ...(settled.control !== undefined ? { fromViewerID: settled.control } : {}),
      ...(previous ? { fromLabel: previous.label } : {}),
      toViewerID: viewerID,
      toLabel: claimer.label,
      at: now,
      reason: "claimed",
    },
  }
}

/** Drop the gone without any other change — what the periodic sweep calls. */
export const expire = (room: Room, now: number): Room => settle(room, now)

/** The wire snapshot every attached surface renders. */
export const derive = (room: Room, now: number): SessionPresence.Snapshot => {
  const settled = settle(room, now)
  const viewers = settled.records.map((record) => ({
    viewerID: record.viewerID,
    kind: record.kind,
    label: record.label,
    attachedAt: record.attachedAt,
    writing: record.writing,
  }))
  if (viewers.length === 0) return { state: "unattended", viewers: [] }
  const contended =
    viewers.length > 1 && viewers.some((viewer) => viewer.writing && viewer.viewerID !== settled.control)
  return {
    state: viewers.length === 1 ? "solo" : contended ? "contended" : "watched",
    viewers,
    ...(settled.control !== undefined ? { control: settled.control } : {}),
    ...(settled.handoff ? { handoff: settled.handoff } : {}),
  }
}

/** Structural equality on the rendered snapshot — the service publishes only when this says so. */
export const sameSnapshot = (a: SessionPresence.Snapshot, b: SessionPresence.Snapshot) =>
  JSON.stringify(a) === JSON.stringify(b)
