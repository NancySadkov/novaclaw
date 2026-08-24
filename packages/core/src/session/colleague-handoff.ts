export * as ColleagueHandoff from "./colleague-handoff"

import { and, desc, eq } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { AgentRetire } from "../agent/retire"
import { ColleagueBound } from "./colleague-bound"
import { ConfigAgent } from "../config/agent"
import { OfficerName } from "../agent/officer-name"
import { Database } from "../database/database"
import { Identifier } from "../id/id"
import { EventV2 } from "../event"
import { Memory } from "../kb-graph/memory"
import { makeLocationNode } from "../effect/app-node"
import { ColleagueNote } from "./colleague-note"
import { RosterChat } from "./roster-chat"
import { SessionMessageTable } from "./sql"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionRunCoordinator } from "./run-coordinator"
import { SessionSchema } from "./schema"
import { AgentV2 } from "../agent"
import { SessionStore } from "./store"

// Handing work from one colleague to another (AGENTS.md — the structural metaphor).
//
// 🔴 **This runs on the HOST, always.** A colleague's chat is not the sending worker's session, so
// admitting its input publishes an event whose id is not that worker's lease — which
// `session-worker/event-bridge.ts` rejects by design, and rightly: a worker must not be able to
// write into anyone else's transcript. Measured on a live turn 2026-08-21, before this seam existed,
// the tool came back *"session event does not belong to this worker"*. `spawn` solved the identical
// problem the identical way: the worker asks, the host acts, and the identity is stamped from the
// lease rather than taken from the payload.
//
// So this module holds the DELIVERY, and the two callers reach it differently: the tool inside a
// worker goes over `colleague-ask`, while a host-side caller (or a session running in-process) calls
// it directly. One implementation either way — the split is transport, never behaviour.

/**
 * Which colleague last wrote INTO this chat as a peer, if any.
 *
 * ⚠️ Reads the transcript, because the transcript is the record. The alternative — a "pending reply"
 * row keyed on a pair of sessions — is exactly the sideband the owner ruled out (2026-08-21: one chat
 * stream per agent, never several, so an agent's memory of a conversation is not split across places
 * that can disagree). It also cannot go stale: a message that is in the stream happened.
 *
 * `undefined` when nothing peer-shaped has arrived, which is the ordinary case for a first hand-off.
 */
interface PeerContext {
  /** Which colleague last wrote in as a peer, skipping the user's own interjections. */
  readonly label: string | undefined
  /**
   * How deep the chain reaching this session is — 0 when a person spoke most recently.
   *
   * ⚠️ **Read by a DIFFERENT rule than `label`, over the same rows, and the difference is the whole
   * user exemption.** `label` skips the user's messages, because a person interjecting mid-exchange
   * does not make a colleague's question stop being unanswered. `hops` STOPS at them: the user
   * speaking is exactly what re-authorizes a chain, so a user message found before any peer message
   * means this session is one hop from a person. Neither rule is right for both questions, and
   * collapsing them would either exempt nobody or exempt everybody.
   */
  readonly hops: number
}

const lastPeerContext = (db: Database.Interface["db"], session: SessionSchema.ID): Effect.Effect<PeerContext> =>
  db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(and(eq(SessionMessageTable.session_id, session), eq(SessionMessageTable.type, "user")))
    .orderBy(desc(SessionMessageTable.seq))
    .limit(PEER_LOOKBACK)
    .all()
    .pipe(
      Effect.map((rows) => {
        let label: string | undefined
        let hops: number | undefined
        for (const row of rows) {
          const origin = (
            row.data as {
              readonly origin?: { readonly via?: string; readonly label?: string; readonly hops?: number }
            }
          )?.origin
          const peer = origin?.via === "agent"
          // The FIRST peer message walking backwards wins, and the user's own messages in between are
          // skipped rather than ending the search: a person interjecting in the middle of a colleague
          // exchange does not make the colleague's question stop being unanswered.
          if (peer && label === undefined && typeof origin?.label === "string") label = origin.label
          // The chain depth is decided by whichever came LAST, so the walk stops at the first row of
          // either kind. A message with no agent origin is the user at the composer.
          if (hops === undefined) hops = peer ? (typeof origin?.hops === "number" ? origin.hops : 0) : 0
          if (label !== undefined && hops !== undefined) break
        }
        return { label, hops: hops ?? 0 } satisfies PeerContext
      }),
      Effect.orDie,
    )

/** How far back to look for the last peer message. Bounded so a long chat costs a fixed read; past
 *  this many of the sender's own turns, an exchange is not one round trip any more. */
const PEER_LOOKBACK = 12

export interface Delivery {
  /** False when that colleague has no open chat to leave this in — a fact, not a failure. */
  readonly delivered: boolean
  /** Whether anything is actually running their chat. `false` = durable but dormant. */
  readonly started: boolean
  /**
   * Why the bound refused this hand-off, when it did.
   *
   * ⚠️ A REASON, not a boolean, and it is the sender's to read. "Not delivered" and "not delivered
   * because you are four colleagues deep and the user needs to hear this" send a model to two
   * completely different next actions, and only the second one ends the loop.
   */
  readonly refused?: string | undefined
}

/** The outcome of addressing several colleagues at once — see `Interface.deliverGroup`. */
export interface GroupDelivery {
  /** The id every copy carries, so a reply can address the set. Absent when nothing was delivered. */
  readonly conversation?: string | undefined
  /**
   * Exactly who received it.
   *
   * 🔴 This must equal what the recipients' `participants` list says, or the conference is a lie:
   * they would answer colleagues who never heard the question and could not tell.
   */
  readonly delivered: ReadonlyArray<string>
  /** Named colleagues with no open chat to leave this in — a fact for the sender, not a failure. */
  readonly missing: ReadonlyArray<string>
  /** Whether anything is actually running. `false` = durable but dormant. */
  readonly started: boolean
  readonly refused?: string | undefined
}

export interface Hired {
  readonly id: string
  readonly name: string
}

export interface Interface {
  /**
   * Staff the organization: write the role and make it LIVE.
   *
   * 🔴 Host-side for the same reason delivery is, and the reason was measured: the tool ran the
   * store write inside the worker and reloaded the WORKER's roster, so `Procius` existed durably and
   * the instance's own `GET /api/agent` did not list him. Same "durable but not live" defect the
   * delete endpoint had — a colleague nobody can see is a colleague nobody can talk to.
   */
  readonly hire: (input: {
    readonly title: string
    readonly brief: string
    readonly personality?: string | undefined
  }) => Effect.Effect<Hired>
  /**
   * Retire a colleague: remove the role, forget what it spent, and CLEAR ITS CABINET.
   *
   * 🔴 The memory goes because the id comes back. A retired name returns to the Greek pool, so a
   * future colleague drawn as `theron` would open holding the old Theron's private memories —
   * identity bleed of the worst kind, and the same hazard the per-minute series was cleared for.
   * Measured 2026-08-21: before this, a retired colleague's `agent:<id>` rows survived while the
   * tool's own message said "what they remembered goes with them". The message was the honest half.
   */
  readonly retire: (colleague: string) => Effect.Effect<boolean>
  /**
   * Leave a message in a colleague's own chat, attributed to the sender.
   *
   * `from` is the SENDER'S SESSION and the caller must have authority over it — the worker bridge
   * takes it from the lease, so a worker can speak as itself and as nobody else.
   */
  readonly deliver: (input: {
    readonly from: SessionSchema.ID
    readonly colleague: string
    readonly message: string
  }) => Effect.Effect<Delivery>
  /**
   * Put ONE message in front of SEVERAL colleagues, as one conversation.
   *
   * 🔴 There is no conference session, deliberately. Agents and sessions are the same first-class
   * entity, so a session with no personality would re-introduce the split that merge removes, and a
   * participant with two streams is the thing *"maintaining the agent's ego and consciousness"*
   * forbids. Each recipient gets it in THEIR OWN chat; the shared `conversation` id on the origin is
   * what makes those copies one exchange.
   *
   * ⚠️ The bound is charged ONCE PER RECIPIENT. A group that charged once would turn one lap into N
   * for the price of one — see `ColleagueBound.hasCapacityFor`.
   */
  readonly deliverGroup: (input: {
    readonly from: SessionSchema.ID
    readonly colleagues: ReadonlyArray<string>
    readonly message: string
  }) => Effect.Effect<GroupDelivery>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ColleagueHandoff") {}

/**
 * Land one colleague message in one chat, and wake it. THE ONLY PLACE a hand-off is written.
 *
 * 🔴 Extracted when group delivery arrived. A group is a fan-out of exactly this, and writing it a
 * second time is how the two drift: the peer attribution, the hop stamp and the wake-after-admit
 * ordering are each load-bearing, and each was learned from a defect. A second copy inherits none of
 * that history and will lose one of them quietly.
 */
const landColleagueMessage = (
  deps: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly wake: (id: SessionSchema.ID) => Effect.Effect<boolean>
  },
  args: {
    readonly chatID: SessionSchema.ID
    readonly from: SessionSchema.ID
    readonly message: string
    readonly label: string | undefined
    readonly turn: ReturnType<typeof ColleagueNote.turnFor>
    readonly hop: number
    readonly conversation?: string | undefined
    readonly participants?: ReadonlyArray<string> | undefined
    /** Who this copy is FOR — used to leave them out of "the others" in their own note. */
    readonly recipient?: string | undefined
  },
) =>
  Effect.gen(function* () {
    yield* SessionInput.admit(deps.db, deps.events, {
      id: SessionMessage.ID.create(),
      sessionID: args.chatID,
      prompt: {
        // The colleague's words, plus HOW TO ANSWER — the note is the entire reply channel, and an
        // answer's note differs from a question's so the exchange stops at one round trip
        // (`colleague-note.ts` holds the argument).
        text: ColleagueNote.compose({
          message: args.message,
          from: args.label ?? String(args.from),
          turn: args.turn,
          // The room MINUS the sender (the note names them separately) and minus the reader, who
          // does not need telling they are here. Absent for a 1:1, which keeps that note identical.
          ...(args.participants === undefined
            ? {}
            : {
                group: args.participants.filter(
                  (id) => id !== args.recipient && id !== (args.label ?? String(args.from)),
                ),
              }),
        }),
        files: [],
        agents: [],
        // PEER, not parent — `session/origin.ts` renders the two differently, and the difference is
        // durable in the receiver's transcript.
        origin: {
          via: "agent",
          sessionID: args.from,
          relation: "peer",
          // Stamped so the RECEIVER knows how far from a person it is: without this the chain is
          // invisible to everyone in it, which is how a loop that every hop finds reasonable runs.
          hops: args.hop,
          ...(args.label === undefined ? {} : { label: args.label }),
          // Absent for a 1:1 hand-off, so every existing exchange is byte-identical to before.
          ...(args.conversation === undefined ? {} : { conversation: args.conversation }),
          ...(args.participants === undefined ? {} : { participants: [...args.participants] }),
        },
      },
      delivery: "queue",
    }).pipe(Effect.orDie)
    // Strictly AFTER the admit: the executor's drain reads the queued row from the database, so
    // waking first is a race that ends in an empty turn (`spawner.ts` learned this).
    return yield* deps.wake(args.chatID)
  })

/**
 * Build the delivery from parts the caller already holds.
 *
 * 🔴 **This exists because resolving a SERVICE inside a per-request host handler abandons the turn.**
 * `session-worker/execution.ts` carries the warning in capitals for `SessionJoin` — "resolving a
 * service that is not already in the location graph inside this per-request handler abandons every
 * tool-call turn" — and this seam walked straight into it: the first live hand-off left the sender's
 * tool call `running` forever, with nothing in the log, because the handler never returned. Measured
 * 2026-08-21. `SessionJoin.fromEvents` is the same shape for the same reason.
 */
export const fromParts = (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly session: (id: SessionSchema.ID) => Effect.Effect<{ readonly agent?: string | undefined } | undefined>
  readonly wake: (id: SessionSchema.ID) => Effect.Effect<boolean>
  readonly store: AgentConfigStore.Interface
  /** Re-materialise the LIVE roster after a staffing change. Without it a hire is durable and
   *  invisible — measured: `Procius` was in the store and absent from `GET /api/agent`. */
  readonly refresh: Effect.Effect<void>
  readonly takenNames: Effect.Effect<ReadonlyArray<string>>
  /** Erase everything keyed on the retired id — `AgentRetire.everything`. Passed in rather than
   *  built here because the per-request host handler cannot resolve a memory service (see above). */
  readonly forget: (colleague: string) => Effect.Effect<void>
}): Interface => ({
  hire: Effect.fn("ColleagueHandoff.hire")(function* (request) {
    // The name is DRAWN, never chosen by a model: a roster sits in an address book beside real
    // people, and a colleague called "Sarah" is one misread from being taken for one. Taken names —
    // ids and display names alike — are avoided, because the collision that matters is a reading one.
    const drawn = OfficerName.pick({ taken: yield* input.takenNames, random: Math.random })
    const display = OfficerName.display(drawn)
    yield* input.store.setLayers(drawn, [
      Schema.decodeUnknownSync(ConfigAgent.Info)({
        name: display,
        title: request.title,
        system: request.brief,
        mode: "primary",
        ...(request.personality === undefined ? {} : { personality: request.personality }),
      }),
    ])
    yield* input.refresh
    return { id: drawn, name: display }
  }),
  retire: Effect.fn("ColleagueHandoff.retire")(function* (colleague) {
    yield* input.store.removeAgent(colleague)
    yield* input.forget(colleague)
    yield* input.refresh
    return true
  }),
  deliver: Effect.fn("ColleagueHandoff.deliver")(function* (request) {
    const chat = yield* RosterChat.chatFor(input.db, request.colleague)
    if (chat === undefined) return { delivered: false, started: false }
    // The sender's own agent, read from ITS session row rather than trusted from the caller: the
    // label is what the receiver sees as "who is asking", and a hand-off that could name anyone
    // would make the attribution worthless.
    const sender = yield* input.session(request.from)
    const label = sender?.agent
    // ANSWER or QUESTION, read from the SENDER'S OWN CHAT rather than from a flag the caller sets or
    // a side table: if the last peer message that arrived in the sender's stream came from the
    // colleague it is now writing to, this is the reply to it. One stream is the record (owner,
    // 2026-08-21: everything goes through the normal chat, never a sideband), so the stream is also
    // where the question "who spoke last?" is answered.
    // 🔴 NEVER INTO YOUR OWN CHAT, checked at the DELIVERY layer and not only at the tool.
    //
    // `ColleagueTool.addressable` already filters the sender out of the roster it offers, and that is
    // the layer a model meets. But `deliver` is the SHARED rule — the worker bridge reaches it, a
    // host-side caller reaches it directly, and anything added later will too. A self-delivery
    // appends to the conversation the sender is currently having: an infinite regress it cannot see
    // it is starting, and one the hop counter cannot bound because every lap looks like a fresh ask.
    //
    // ⚠️ Found by writing `colleague-concurrency.test.ts`, which admitted one and passed. The rule
    // existed in exactly one place and read as though it were everywhere.
    const senderAgent = (yield* input.session(request.from))?.agent
    if (senderAgent !== undefined && senderAgent === request.colleague)
      return {
        delivered: false,
        started: false,
        refused:
          `Not delivered: ${request.colleague} is you. A message to yourself would land in this same ` +
          `conversation. Say what you were going to say, or hand it to a different colleague.`,
      }
    const context = yield* lastPeerContext(input.db, request.from)
    const askedByRecipient = context.label === request.colleague
    const turn = ColleagueNote.turnFor({ askedByRecipient })
    // 🔴 THE BOUND, checked before anything is written. Both refusals return `delivered: false` with a
    // reason the sender reads as its tool result — see `colleague-bound.ts` for why the note's
    // asymmetry alone was never enough, and why these two mechanisms catch different failures.
    //
    // ⚠️ Ordered hop-then-rate on purpose: a colleague deep in a chain is told about the CHAIN, which
    // is the fact that tells it to go back to the user. Reporting a rate limit to a model whose real
    // problem is depth would have it wait and then continue the loop.
    const hop = ColleagueBound.nextHop(context.hops)
    if (ColleagueBound.exceedsHopCap(hop))
      return { delivered: false, started: false, refused: ColleagueBound.hopRefusal({ colleague: request.colleague, hop }) }
    const now = yield* Clock.currentTimeMillis
    // Keyed on the sender's SESSION, which is one chat per colleague — so this is per-colleague
    // without needing the agent id, and a colleague with no agent row still gets a window.
    if (ColleagueBound.rateExceeded(String(request.from), now))
      return { delivered: false, started: false, refused: ColleagueBound.rateRefusal({ colleague: request.colleague }) }
    const started = yield* landColleagueMessage(input, {
      chatID: chat.id as SessionSchema.ID,
      from: request.from,
      message: request.message,
      label,
      turn,
      hop,
    })
    // AFTER the admit, so a refused or failed hand-off never spends the sender's allowance.
    ColleagueBound.record(String(request.from), now)
    return { delivered: true, started }
  }),
  deliverGroup: Effect.fn("ColleagueHandoff.deliverGroup")(function* (request) {
    const sender = yield* input.session(request.from)
    const label = sender?.agent
    // Self is dropped rather than refused: a model listing the whole roster to reach "everyone" is
    // doing something reasonable, and `deliver` refuses self-delivery for the harder reason that it
    // would append to the conversation the sender is currently having.
    const named = [...new Set(request.colleagues.map((id) => id.trim()).filter((id) => id !== ""))].filter(
      (id) => id !== label,
    )
    if (named.length === 0)
      return {
        delivered: [],
        missing: [],
        started: false,
        refused: "Name at least one colleague other than yourself — call `list` to see who works here.",
      }

    // Who can actually be reached. A colleague with no open chat is left OUT of the conference
    // rather than blocking it, and reported: `participants` must name exactly who received this, or
    // the recipients would answer someone who never heard the question and nobody could tell.
    const reachable: string[] = []
    const missing: string[] = []
    for (const colleague of named) {
      const chat = yield* RosterChat.chatFor(input.db, colleague)
      if (chat === undefined) missing.push(colleague)
      else reachable.push(colleague)
    }
    if (reachable.length === 0) return { delivered: [], missing, started: false }

    const context = yield* lastPeerContext(input.db, request.from)
    const hop = ColleagueBound.nextHop(context.hops)
    if (ColleagueBound.exceedsHopCap(hop))
      return {
        delivered: [],
        missing,
        started: false,
        refused: ColleagueBound.hopRefusal({ colleague: reachable.join(", "), hop }),
      }
    const now = yield* Clock.currentTimeMillis
    // 🔴 Capacity for the WHOLE group, checked before anything is written. Asking `rateExceeded` and
    // then delivering N times would check a budget of one against a spend of N.
    if (!ColleagueBound.hasCapacityFor(String(request.from), now, reachable.length))
      return {
        delivered: [],
        missing,
        started: false,
        refused: ColleagueBound.rateRefusal({ colleague: reachable.join(", ") }),
      }

    const conversation = Identifier.ascending("conversation")
    // The sender is IN the list: a reply has to reach them too, and rebuilding "the set plus
    // whoever wrote to me" from two fields is how one of them ends up wrong.
    const participants = [label ?? String(request.from), ...reachable]
    let started = false
    for (const colleague of reachable) {
      const chat = yield* RosterChat.chatFor(input.db, colleague)
      if (chat === undefined) continue
      const woke = yield* landColleagueMessage(input, {
        chatID: chat.id as SessionSchema.ID,
        from: request.from,
        message: request.message,
        label,
        // Per recipient: an answer's note differs from a question's, and in a group one participant
        // may be answering the sender while the others are being asked for the first time.
        turn: ColleagueNote.turnFor({ askedByRecipient: context.label === colleague }),
        hop,
        conversation,
        participants,
        recipient: colleague,
      })
      started = started || woke
    }
    // AFTER the writes, once per recipient — see `hasCapacityFor`.
    ColleagueBound.recordMany(String(request.from), now, reachable.length)
    return { conversation, delivered: reachable, missing, started }
  }),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const sessions = yield* SessionStore.Service
    const wake = yield* SessionRunCoordinator.Wake
    // ONE implementation, reached two ways. The layer is for graphs that can resolve services at
    // build time; `fromParts` is for the per-request handler that cannot.
    const store = yield* AgentConfigStore.Service
    const agents = yield* AgentV2.Service
    const memory = Memory.client(yield* Memory.node.service)
    return Service.of(
      fromParts({
        db,
        events,
        session: (id) => sessions.get(id),
        wake: (id) => wake.wake(id),
        store,
        refresh: agents.reload(),
        forget: (colleague) => AgentRetire.everything({ db, events, memory, agent: colleague, at: Date.now() }),
        takenNames: agents.all().pipe(Effect.map((all) => all.flatMap((one) => [String(one.id), one.name ?? ""]))),
      }),
    )
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    SessionStore.node,
    SessionRunCoordinator.wakeNode,
    AgentConfigStore.node,
    AgentV2.node,
    Memory.node,
  ],
})
