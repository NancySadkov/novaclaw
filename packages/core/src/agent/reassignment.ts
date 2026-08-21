export * as AgentReassignment from "./reassignment"

import { DateTime, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { RosterChat } from "../session/roster-chat"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { AgentWorkspace } from "./workspace"

// TELLING a colleague its folder changed (owner, 2026-08-21: *"reassigning agent to another folder
// should auto send a message to it, so it won't be thinking it still works on the old project"*).
//
// 🔴 **The registry exists because the DETECTION and the DELIVERY live in different places.**
// `config-store-write.ts` is the one door every config write passes through — the dialog's Save, the
// `configure` tool, Nova editing a colleague — so it is the only place that can see a folder change
// whoever made it. But it is a global-scope store module: it holds no sessions, no event bus and no
// way to admit a message into a chat. Delivery needs all three.
//
// So the write door DETECTS and announces; whatever graph owns sessions REGISTERS to deliver. Same
// shape as `registerReload` in that module, deliberately — a second mechanism for "config changed,
// tell something" is exactly the kind of duplicate that drifts apart.
//
// ⚠️ **Nobody registered is not an error.** A CLI writing config with no instance running has no
// chat to deliver into, and the colleague will read its new folder out of its system prompt on its
// next turn anyway. The notice is a courtesy for a LIVE colleague mid-conversation, not a
// correctness mechanism — treating a missing listener as a fault would make an offline config edit
// fail for wanting an audience.

/** What a listener is handed: who moved, and where from and to. */
export interface Move {
  readonly agentID: string
  readonly from: string
  readonly to: string
  readonly ownScratch: boolean
}

type Listener = { readonly notify: (move: Move) => Effect.Effect<void> }

const listeners = new Set<Listener>()

/**
 * Register a delivery for the life of a scope.
 *
 * The token is an object rather than the function itself, so two locations that somehow share a
 * `notify` reference still count as two — the same reasoning `registerReload` records.
 */
export const register = (notify: (move: Move) => Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener: Listener = { notify }
      listeners.add(listener)
      return listener
    }),
    (listener) =>
      Effect.sync(() => {
        listeners.delete(listener)
      }),
  ).pipe(Effect.asVoid)

/** How many deliveries are live. Exported so "the wiring exists" can be asserted, not reasoned about. */
export const registered = (): number => listeners.size

/**
 * Announce a move to every listener.
 *
 * ⚠️ Best-effort per listener: a delivery that fails must not roll back a config write that has
 * already committed. The colleague would then be pointed at a new folder with no notice, which is
 * the pre-fix behaviour — worse than today, better than a 500 on a save that worked.
 *
 * ⚠️ **`catchCause`, not `ignore`** — and the test caught this claim being false. `Effect.ignore`
 * discharges the ERROR channel and lets a DEFECT through, so a listener with a null deref in it would
 * still have propagated out of a committed write and surfaced as a 500 on a save that worked. A
 * "best-effort" that only survives the failures you predicted is not best-effort.
 */
export const announce = (move: Move): Effect.Effect<void> =>
  Effect.forEach([...listeners], (listener) => listener.notify(move).pipe(Effect.catchCause(() => Effect.void)), {
    discard: true,
  })

/** The message a moved colleague receives. Re-exported here so a caller needs one import. */
export const notice = AgentWorkspace.reassignmentNotice

/**
 * The delivery itself: put the notice in the colleague's own chat.
 *
 * 🔴 A SYNTHETIC message, which is the precedent this situation already has —
 * `folderSubstitutedNotice` publishes one when a session's folder is substituted underneath it, for
 * exactly the same reason. It lowers to a `user`-role message (`to-llm-message.ts`), so the colleague
 * reads it on its next turn, AND it renders in the transcript, so the person scrolling back sees why
 * the work moved. One mechanism serving both readers.
 *
 * ⚠️ **It does not WAKE the chat**, deliberately. Waking would spend a turn on acknowledging a folder
 * change — and the notice's own wording tells the colleague not to act on it. It needs to know when
 * it next thinks, not this second.
 *
 * ⚠️ A colleague with no open chat is skipped, not queued: there is nowhere to leave this, and
 * starting a conversation the user has never seen in order to announce a settings change is worse
 * than silence. Its next chat begins with the new folder in its prompt anyway.
 */
export const deliver = (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly move: Move
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const chat = yield* RosterChat.chatFor(input.db, input.move.agentID)
    if (chat === undefined) return false
    yield* input.events
      .publish(SessionEvent.Synthetic, {
        sessionID: chat.id as SessionSchema.ID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: notice(input.move),
      })
      .pipe(Effect.ignore)
    return true
  })

/**
 * The scoped registration an instance graph makes: detection happens at the config door, delivery
 * here.
 *
 * ⚠️ GLOBAL, not per-location. A config write is instance-wide — one `PATCH /config` moves a
 * colleague once, not once per open folder — and both services this needs (`Database`, `EventV2`) are
 * global too. A location node would have registered one listener per open location and delivered the
 * same notice that many times.
 */
export const node = makeGlobalNode({
  name: "agent/reassignment",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* register((move) => deliver({ db, events, move }).pipe(Effect.asVoid))
    }),
  ),
  deps: [Database.node, EventV2.node],
})
