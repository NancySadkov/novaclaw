export * as ColleagueHandoff from "./colleague-handoff"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { AgentUsage } from "../agent/usage"
import { ConfigAgent } from "../config/agent"
import { OfficerName } from "../agent/officer-name"
import { Database } from "../database/database"
import { EventV2 } from "../event"
import { makeLocationNode } from "../effect/app-node"
import { RosterChat } from "./roster-chat"
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

export interface Delivery {
  /** False when that colleague has no open chat to leave this in — a fact, not a failure. */
  readonly delivered: boolean
  /** Whether anything is actually running their chat. `false` = durable but dormant. */
  readonly started: boolean
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
  /** Retire a colleague, and refresh the live roster so they actually disappear. */
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
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ColleagueHandoff") {}

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
    yield* AgentUsage.forget(input.db, colleague)
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
    yield* SessionInput.admit(input.db, input.events, {
      id: SessionMessage.ID.create(),
      sessionID: chat.id as SessionSchema.ID,
      prompt: {
        text: request.message,
        files: [],
        agents: [],
        // PEER, not parent — `session/origin.ts` renders the two differently, and the difference is
        // durable in the receiver's transcript.
        origin: {
          via: "agent",
          sessionID: request.from,
          relation: "peer",
          ...(label === undefined ? {} : { label }),
        },
      },
      delivery: "queue",
    }).pipe(Effect.orDie)
    // Strictly AFTER the admit: the executor's drain reads the queued row from the database, so
    // waking first is a race that ends in an empty turn (`spawner.ts` learned this).
    const started = yield* input.wake(chat.id as SessionSchema.ID)
    return { delivered: true, started }
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
    return Service.of(
      fromParts({
        db,
        events,
        session: (id) => sessions.get(id),
        wake: (id) => wake.wake(id),
        store,
        refresh: agents.reload(),
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
  ],
})
