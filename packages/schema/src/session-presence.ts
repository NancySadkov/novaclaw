export * as SessionPresence from "./session-presence"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { NonNegativeInt, optional } from "./schema"
import { SessionID } from "./session-id"

/**
 * The **presence** component on the session entity (architecture.md's ECS lens): who or what is
 * attached to a chat right now, which of them is driving, and whether two of them are reaching for
 * it at the same time.
 *
 * ## What this is NOT
 *
 * 🔴 **It is not a "who is online" registry, and it must never grow into one.** AGENTS.md:
 * *"an instance is ATOMIC, and that is a product rule, not just a topology … We never split the
 * product into a client edition and a server edition … When a capability seems to want a server,
 * the P2P answer is another instance."* Presence is the classic feature that quietly acquires a
 * broker, so the shape here is deliberately narrow: **an instance publishes presence only for the
 * sessions it already owns**, to the clients that are already authenticated to it. There is no
 * directory, no rendezvous node, nothing extra to keep alive — presence has *exactly the same
 * availability domain as the session itself*, which is the test for "did this grow a server".
 * A remote peer looking at a session through the shipped inter-instance channel is simply another
 * {@link Viewer} row with `kind: "peer"`; it heartbeats the same endpoint as a browser tab and gets
 * no second protocol.
 *
 * ## Busy is NOT here, on purpose
 *
 * "Is this session working right now?" is already answered by `session.status`
 * (`session-status-event.ts`) and read in the app as `session_working`. Two answers to that
 * question that can disagree is the defect shape this repo keeps hitting, so presence describes
 * only the *attendance* half and the UI composes the two.
 */

/** What kind of CPU is attached. The kernel treats the user as an agent whose CPU is a human. */
export const ViewerKind = Schema.Literals(["human", "agent", "peer"])
export type ViewerKind = typeof ViewerKind.Type

export const Viewer = Schema.Struct({
  /** Stable per-surface id, minted by the client (one per browser tab / window / peer link). */
  viewerID: Schema.String,
  kind: ViewerKind,
  /** Human-readable — "this browser", "Nova on the Spark". Never an id the user must decode. */
  label: Schema.String,
  attachedAt: NonNegativeInt,
  // ⚠️ There is deliberately no `lastSeenAt` on the wire. Every listed viewer is live by
  // construction (the instance prunes the rest), and a field that changes on every heartbeat would
  // make the snapshot differ from itself each beat — which would republish to every attached
  // surface ten times a minute and say nothing.
  /** True while this viewer has an unsent draft — what makes a conflict visible before it happens. */
  writing: Schema.Boolean,
}).annotate({ identifier: "SessionPresenceViewer" })
export type Viewer = typeof Viewer.Type

/**
 * The last time control changed hands. Rendered as a calm notice, never as an error.
 *
 * ⚠️ It carries LABELS as well as ids because the outgoing viewer is gone by then — its row has
 * been pruned, so a UI holding only `fromViewerID` could not name who left.
 */
export const Handoff = Schema.Struct({
  fromViewerID: optional(Schema.String),
  fromLabel: optional(Schema.String),
  toViewerID: Schema.String,
  toLabel: Schema.String,
  at: NonNegativeInt,
  /** `claimed` = someone took over deliberately; `succession` = the driver left and control passed on. */
  reason: Schema.Literals(["claimed", "succession"]),
}).annotate({ identifier: "SessionPresenceHandoff" })
export type Handoff = typeof Handoff.Type

/**
 * - `unattended` — nobody is looking. A session can be busy and unattended; that is normal.
 * - `solo` — exactly one viewer, and it drives.
 * - `watched` — several attached, one drives, nobody else is writing.
 * - `contended` — several attached and someone who is not driving is writing too.
 */
export const State = Schema.Literals(["unattended", "solo", "watched", "contended"])
export type State = typeof State.Type

export const Snapshot = Schema.Struct({
  state: State,
  /** Live viewers only, oldest attachment first — the succession order. */
  viewers: Schema.Array(Viewer),
  /** The driver. Never empty while a live viewer exists: control succeeds rather than going vacant. */
  control: optional(Schema.String),
  handoff: optional(Handoff),
}).annotate({ identifier: "SessionPresenceSnapshot" })
export type Snapshot = typeof Snapshot.Type

/** One event carries the WHOLE per-session snapshot — idempotent client folds, no ordering to reconcile. */
const Updated = define({
  type: "session.presence.updated",
  schema: {
    sessionID: SessionID,
    presence: Snapshot,
  },
})

export const Event = { Updated, Definitions: inventory(Updated) }
