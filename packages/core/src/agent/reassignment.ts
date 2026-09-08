export * as AgentReassignment from "./reassignment"

import { DateTime, Effect, Exit, Layer } from "effect"
import { Database } from "../database/database"
import { Log } from "@novaclaw/schema/log"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { AbsolutePath } from "../schema"
import { AgentV2 } from "../agent"
import { ProjectV2 } from "../project"
import { createSessionRecord } from "../session"
import { RosterChat } from "../session/roster-chat"
import { SessionPatch } from "../session/patch"
import { SessionStore } from "../session/store"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { AgentWorkspace } from "./workspace"
import { GraphRegistry } from "./graph-registry"

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

/**
 * ⚠️ **Per GRAPH, not per process** — see `agent/graph-registry.ts`. A module-level `Set` here
 * delivered one instance's reassignment notice into ANOTHER instance's chat for the same colleague
 * id, archiving a transcript nobody moved. Officer ids come from a fixed pool, so the same id
 * existing in two instances is the normal case.
 */
const listeners = GraphRegistry.make<Listener>()

/**
 * Register a delivery for the life of a scope, in the CALLING graph.
 *
 * The token is an object rather than the function itself, so two locations that somehow share a
 * `notify` reference still count as two — the same reasoning `registerReload` records.
 */
export const register = (notify: (move: Move) => Effect.Effect<void>) => listeners.register({ notify })

/**
 * How many deliveries are live IN ONE GRAPH. Exported so "the wiring exists" can be asserted, not
 * reasoned about — and a count that summed every graph in the process could not answer that.
 */
export const registered = (graph?: GraphRegistry.Graph): number => listeners.entries(graph).length

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
  // ⚠️ `listeners.visible`, not every listener in the process: a config write in one instance
  // announces to that instance and to no other.
  Effect.flatMap(listeners.visible, (live) =>
    Effect.forEach(live, (listener) => listener.notify(move).pipe(Effect.catchCause(() => Effect.void)), {
      discard: true,
    }),
  )

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
  readonly projects: ProjectV2.Interface
  readonly store: SessionStore.Interface
  readonly move: Move
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const chat = yield* RosterChat.chatFor(input.db, input.move.agentID)
    if (chat === undefined) return false

    // The successor is an empty chat. Do not leave a world-change nudge in it when the old chat had
    // never received model output: on a cleared/new conversation this is just transcript litter and
    // the next real prompt already supplies the context that matters.
    const previous = yield* input.store.context(SessionSchema.ID.make(chat.id)).pipe(
      Effect.catchTag("Session.MessageDecodeError", (error) =>
        Log.event("session.message.decode.failed", {
          "session.id": error.sessionID,
          "session.message": error.messageID,
          "session.ref": `err_${crypto.randomUUID().slice(0, 8)}`,
        }).pipe(Effect.as([] as SessionMessage.Message[])),
      ),
    )
    const hadModelOutput = AgentWorkspace.hasModelOutput(previous)

    // 🔴 ARCHIVE, then open the successor in the NEW folder. The chat does not follow its colleague
    // and never could: `control-plane/move-session.ts` refuses a cross-project move outright, so the
    // old behaviour was a notice admitting the chat was stranded and telling the user to clear it
    // themselves. That is homework, and *a common user is helped, not handed a pager*.
    //
    // Nothing is destroyed. Compaction files a transcript into the colleague's own cabinet as
    // passages (`session/compaction-archive.ts`) and `kb search` reads them back — continuity lives
    // in the cabinet, not the transcript. This is the same archive-then-fresh mechanism **Clear
    // chat** already uses; reassignment is that event with a different trigger.
    // 🔴 THE FALLIBLE WORK RUNS FIRST, so there is nothing to roll back.
    //
    // The archive and the successor-create are two writes with no transaction between them, and a
    // failure in the gap left the colleague ARCHIVED WITH NO SUCCESSOR — unreachable, because the
    // roster row is the only door into a colleague's chat. The fix for stranding could strand.
    //
    // ⚠️ Compensating afterwards is NOT available and the reason is worth recording: `projector.ts`
    // writes `undefined` for an absent `time.archived`, deliberately, so that a partial round-trip
    // does not blank every column — and drizzle omits `undefined` from a SET clause. So "un-archive"
    // is not expressible through the patch seam at all. A rollback written that way compiles, runs,
    // and does nothing. (It did. The test caught it.)
    //
    // Resolving the project is the part that reaches outside this function, so doing it here shrinks
    // the gap to a local insert. `createSessionRecord` resolves the same path again; that is a cheap
    // repeat of a memoised lookup, not a second source of truth.
    const resolved = yield* Effect.exit(input.projects.resolve(AbsolutePath.make(input.move.to)))
    if (!Exit.isSuccess(resolved)) {
      yield* Log.event("agent.reassign.successor.failed", {
        "agent.id": input.move.agentID,
        "session.id": chat.id,
        "agent.fault": Log.fault(resolved.cause),
      })
      // Nothing was archived, so the colleague keeps the chat it had. The folder change still
      // applies — it is read out of the system prompt on the next turn either way.
      return false
    }

    const at = DateTime.makeUnsafe(Date.now())
    yield* SessionPatch.patchSessionRecord(
      { db: input.db, events: input.events },
      SessionSchema.ID.make(chat.id),
      (info) => ({ ...info, time: { ...info.time, archived: at } }),
    )

    // ⚠️ The successor is created EAGERLY rather than lazily, and the notice is why: it is delivered
    // INTO a chat, so archiving without opening one would leave the explanation nowhere to live and
    // the user would meet a silently emptied roster row.
    //
    // ⚠️ This only works because an ARCHIVED chat does not block its successor — one of the four
    // exclusions in the one-chat-per-agent guard (`session-one-chat-per-agent.test.ts`). Without
    // that clause this call would hand back the chat just archived.
    const created = yield* Effect.exit(
      createSessionRecord(
        { db: input.db, events: input.events, projects: input.projects, store: input.store },
        {
          agent: AgentV2.ID.make(input.move.agentID),
          // No `title`: `createSessionRecord` defaults to "New session", which is what `isDefault`
          // recognises — so auto-title is still free to name this chat from its first real exchange.
          location: { directory: AbsolutePath.make(input.move.to) },
        },
      ),
    )
    if (!Exit.isSuccess(created)) {
      // The residual window: the project resolved and the insert still failed. It cannot be undone
      // for the reason above, so it is REPORTED rather than papered over — a colleague with an
      // archived chat and no successor is a state a person has to be told about.
      yield* Log.event("agent.reassign.successor.failed", {
        "agent.id": input.move.agentID,
        "session.id": chat.id,
        "agent.fault": Log.fault(created.cause),
      })
      return false
    }
    const successor = created.value

    if (hadModelOutput) {
      yield* input.events
      .publish(SessionEvent.Synthetic, {
        sessionID: successor.id,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        // Reports what HAPPENED. The old text described a stranded chat and issued an instruction;
        // there is nothing to instruct now, because the thing it asked for has been done. The notice
        // carries steer provenance so the transcript folds it like every other automated nudge while
        // the model still receives the full fact.
        text: notice(input.move),
      })
      // ⚠️ SAID, not swallowed. The header's "nobody registered is not an error" covers a MISSING
      // listener — an offline config edit with no chat to deliver into. This is the opposite case:
      // the chat exists and the notice is the only account the user gets of why their colleague's
      // old conversation ended. Losing it silently is the swallow this module was written to remove,
      // one seam up.
      .pipe(
        Effect.catchCause((cause) =>
          Log.event("agent.reassign.notice.failed", {
            "agent.id": input.move.agentID,
            "session.id": successor.id,
            "agent.fault": Log.fault(cause),
          }),
        ),
      )
    }
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
      const projects = yield* ProjectV2.Service
      const store = yield* SessionStore.Service
      yield* register((move) => deliver({ db, events, projects, store, move }).pipe(Effect.asVoid))
    }),
  ),
  deps: [Database.node, EventV2.node, ProjectV2.node, SessionStore.node],
})
