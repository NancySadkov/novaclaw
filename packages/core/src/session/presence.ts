export * as SessionPresence from "./presence"

import { Context, Effect, Layer } from "effect"
import { SessionPresence as PresenceSchema } from "@novaclaw/schema/session-presence"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionPresenceState } from "./presence-state"
import type { SessionSchema } from "./schema"

export const Event = PresenceSchema.Event
export const { HEARTBEAT_SECONDS, VIEWER_TTL_SECONDS } = SessionPresenceState

/**
 * The presence component's system: it owns one {@link SessionPresenceState.Room} per session and
 * publishes `session.presence.updated` whenever the rendered snapshot actually changes.
 *
 * ## Why this is IN MEMORY, and why that is the correct answer rather than the lazy one
 *
 * Presence describes who is holding a live connection *right now*. Persisting it would mean an
 * instance that restarts comes back claiming three tabs are attached that died with the process —
 * ghosts that only a timeout could clear, and the whole point of the timeout is to be the backstop,
 * not the normal path. Losing the map on restart is *correct*: every surviving client re-reports
 * within {@link HEARTBEAT_SECONDS} seconds, which is the self-healing behaviour AGENTS.md asks for
 * rather than a gap to paper over.
 *
 * ## Why there is no sweeper fiber
 *
 * Expiry is evaluated on every read and every write, so a snapshot is never stale when someone
 * looks at it — and anyone still attached is looking every ten seconds, which is what makes a
 * *departed* viewer disappear from the *remaining* viewer's screen without any timer at all. The
 * only case a background sweep would cover is a room whose last viewer vanished silently, where by
 * definition nobody is watching; {@link Interface.all} prunes those when the next client bootstraps.
 *
 * ## Where the server would have crept in, and how it does not
 *
 * AGENTS.md: *"an instance is ATOMIC … We never split the product into a client edition and a
 * server edition … Our users are not server admins … When a capability seems to want a server, the
 * P2P answer is another instance."* This service is bound as a GLOBAL node of the instance that
 * already owns the sessions — the same process, database and auth boundary the transcript lives
 * behind. It knows nothing about any session it does not own, keeps no roster of instances or
 * users, and there is nothing here for anyone to run, configure or keep alive. Presence has exactly
 * the availability of the session it describes: if this instance is down, so is the chat.
 */
export interface Interface {
  /** Attach, or say "still here". One idempotent call — the client never has to know which it is. */
  readonly report: (
    sessionID: SessionSchema.ID,
    input: SessionPresenceState.ReportInput,
  ) => Effect.Effect<PresenceSchema.Snapshot>
  /** Take the driving seat. A friendly handoff, recorded and announced to everyone attached. */
  readonly claim: (sessionID: SessionSchema.ID, viewerID: string) => Effect.Effect<PresenceSchema.Snapshot>
  /** Say goodbye — a closed tab, a navigation away, a peer hanging up. */
  readonly detach: (sessionID: SessionSchema.ID, viewerID: string) => Effect.Effect<PresenceSchema.Snapshot>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<PresenceSchema.Snapshot>
  /** Every session with someone attached — the client store's bootstrap source. */
  readonly all: () => Effect.Effect<Readonly<Record<string, PresenceSchema.Snapshot>>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionPresence") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const rooms = new Map<string, SessionPresenceState.Room>()

    /** Apply one pure transition, drop the room if it emptied, and publish only a real change. */
    const apply = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      transition: (room: SessionPresenceState.Room, now: number) => SessionPresenceState.Room,
    ) {
      const now = Date.now()
      const before = SessionPresenceState.derive(rooms.get(sessionID) ?? SessionPresenceState.empty, now)
      const next = transition(rooms.get(sessionID) ?? SessionPresenceState.empty, now)
      if (SessionPresenceState.isEmpty(next)) rooms.delete(sessionID)
      else rooms.set(sessionID, next)
      const after = SessionPresenceState.derive(next, now)
      // A heartbeat that changed nothing must not wake every attached surface ten times a minute.
      if (!SessionPresenceState.sameSnapshot(before, after)) {
        yield* events.publish(Event.Updated, { sessionID, presence: after })
      }
      return after
    })

    const report = Effect.fn("SessionPresence.report")(function* (
      sessionID: SessionSchema.ID,
      input: SessionPresenceState.ReportInput,
    ) {
      return yield* apply(sessionID, (room, now) => SessionPresenceState.report(room, input, now))
    })

    const claim = Effect.fn("SessionPresence.claim")(function* (sessionID: SessionSchema.ID, viewerID: string) {
      return yield* apply(sessionID, (room, now) => SessionPresenceState.claim(room, viewerID, now))
    })

    const detach = Effect.fn("SessionPresence.detach")(function* (sessionID: SessionSchema.ID, viewerID: string) {
      return yield* apply(sessionID, (room, now) => SessionPresenceState.detach(room, viewerID, now))
    })

    const get = Effect.fn("SessionPresence.get")(function* (sessionID: SessionSchema.ID) {
      return SessionPresenceState.derive(rooms.get(sessionID) ?? SessionPresenceState.empty, Date.now())
    })

    const all = Effect.fn("SessionPresence.all")(function* () {
      const now = Date.now()
      const out: Record<string, PresenceSchema.Snapshot> = {}
      for (const [sessionID, room] of [...rooms]) {
        const settled = SessionPresenceState.expire(room, now)
        // The bootstrap read doubles as the sweep: a room whose last viewer vanished without
        // saying goodbye is collected here rather than by a timer nobody needed.
        if (SessionPresenceState.isEmpty(settled)) {
          rooms.delete(sessionID)
          continue
        }
        rooms.set(sessionID, settled)
        out[sessionID] = SessionPresenceState.derive(settled, now)
      }
      return out
    })

    return Service.of({ report, claim, detach, get, all })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer))

// Global (instance-wide): presence is attendance on a session entity, not per-location state, and
// the bootstrap endpoint has no location context — the same reasoning as SessionTags.
export const node = makeGlobalNode({ service: Service, layer, deps: [EventV2.node] })
