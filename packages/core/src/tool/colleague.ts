export * as ColleagueTool from "./colleague"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { EventV2 } from "../event"
import { RosterChat } from "../session/roster-chat"
import { SessionRunCoordinator } from "../session/run-coordinator"
import { SessionInput } from "../session/input"
import { SessionMessage } from "../session/message"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Talking to a COLLEAGUE (AGENTS.md — the structural metaphor: officers are peers, and Nova routes
// work to whoever owns it).
//
// 🔴 **This is not `spawn`, and the difference is the whole point.** `spawn` creates nameless staff:
// a child session that inherits your config, does one piece of work and ends. This hands work to a
// COLLEAGUE — someone who already exists, has their own chat, their own memory and their own brief,
// and who answers on their own terms. A CEO that could only spawn would not be routing work; it
// would be doing all of it under different names.
//
// 🔴 **NOT REGISTERED YET, and the reason is measured rather than suspected.** A session runs in its
// own WORKER process, and `session-worker/event-bridge.ts` refuses — by design — to publish an event
// carrying a session id that is not the worker's lease. Driven end to end on 2026-08-21: the model
// called `ask` correctly and the tool came back *"session event does not belong to this worker"*.
//
// That boundary is right, and `spawn` already shows the way past it: *"the worker asks and the HOST
// spawns, under host authority"* (`session-worker/interaction-bridge.ts`), with the parent taken
// from the LEASE so a worker can address nothing it does not own. A colleague hand-off needs the
// same shape — a `colleague-ask` request whose SENDER is stamped host-side — and that is a protocol
// extension, not a call-site fix. Filed in `todo/named-agents.md`.
//
// The module stays because everything except the crossing is settled and tested: who may be
// addressed, what the roster looks like to a model routing work, and what the receiver is told about
// who is asking. Registering it before the crossing exists would ship a tool whose main verb fails —
// exactly the "accepted and discarded" shape this program has spent the week removing.
//
// ⚠️ **Delivered, not awaited.** The message lands in the colleague's own chat and this call
// returns. There is deliberately no `wait`: a peer is not a subroutine, and blocking one officer on
// another's reply is how two colleagues deadlock over a question either could have answered. If the
// sender needs the answer to continue, it says so in the message and ends its turn — the same rule
// as principle 14, one level up.

export const name = "colleague"

const ListOp = Schema.Struct({
  op: Schema.Literal("list"),
})

const AskOp = Schema.Struct({
  op: Schema.Literal("ask"),
  colleague: Schema.String.annotate({
    description: "Which colleague, by id (from `list`).",
  }),
  message: Schema.String.annotate({
    description:
      "What you are asking them to do, in full. They do not see your conversation — say what they need to know.",
  }),
})

export const Input = Schema.Union([ListOp, AskOp])

const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
type Output = typeof Output.Type

/** One line per colleague: who they are and what they own, which is what routing needs. */
export const formatRoster = (
  agents: ReadonlyArray<{
    readonly id: string
    readonly name?: string | undefined
    readonly title?: string | undefined
    readonly description?: string | undefined
  }>,
  selfID: string,
): string => {
  const rows = agents.filter((agent) => agent.id !== selfID)
  if (rows.length === 0)
    return "You have no colleagues yet. Ask the user whether to hire one, or do the work yourself."
  return rows
    .map((agent) => {
      const name = agent.name?.trim() || agent.id
      const role = [agent.title?.trim(), agent.description?.trim()].filter(Boolean).join(" — ")
      return `${agent.id} · ${name}${role ? ` · ${role}` : ""}`
    })
    .join("\n")
}

/** Colleagues you can address: the roster, minus the staff and the machinery, minus yourself. */
export const addressable = (agents: ReadonlyArray<AgentV2.Info>, selfID: string): ReadonlyArray<AgentV2.Info> =>
  agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden && agent.id !== selfID)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const events = yield* EventV2.Service
    // The dependency-free WAKE RELAY, not `SessionExecution` — measured the hard way: depending on
    // the execution service left `@novaclaw/v2/SessionExecution` UNBOUND in the location graph, and
    // every session-create on the instance answered 500. `spawner.ts` reaches the executor through
    // this relay for exactly that reason, and its header says so.
    const wake = yield* SessionRunCoordinator.Wake
    const permission = yield* PermissionV2.Service
    const { db } = yield* Database.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Talk to a colleague — another named agent on this instance, with its own chat, memory and job. " +
            "`list` shows who works here and what they own; `ask` hands one of them a piece of work. They " +
            "answer in their own chat, in their own time; this does not wait for them. Use it instead of doing " +
            "someone else's job, and instead of `spawn` when the work belongs to a role that already exists.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const selfID = String(context.agent ?? "")
              if (input.op === "list") {
                const all = yield* agents.all()
                return { ok: true, message: formatRoster(addressable(all, selfID), selfID) } satisfies Output
              }

              // Addressing a colleague is a capability: it spends THEIR model time and puts words in
              // their transcript under your name. The resource is who you are addressing, so a rule
              // can name one colleague ("may ask the bookkeeper, not the trader").
              yield* permission.assert({
                action: name,
                resources: [input.colleague],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                },
              })

              const target = input.colleague.trim()
              if (target === "" || target === selfID)
                return yield* new ToolFailure({
                  message:
                    target === selfID
                      ? "That is you. Name a different colleague, or just do the work here."
                      : "Name the colleague to ask — call `list` first to see who works here.",
                })

              const all = yield* agents.all()
              const found = addressable(all, selfID).find((agent) => agent.id === target)
              if (found === undefined)
                return yield* new ToolFailure({
                  message:
                    `No colleague called "${target}". Call \`list\` to see who works here — and if nobody owns ` +
                    `this work, say so to the user rather than inventing someone.`,
                })

              const chat = yield* RosterChat.chatFor(db, target)
              if (chat === undefined)
                return {
                  ok: false,
                  // A colleague with no chat is not an error the model can fix by retrying, and
                  // silently starting one on their behalf would put words in a conversation the user
                  // has never seen. Say what is true and let the turn continue.
                  message:
                    `${target} has no open chat yet, so there is nowhere to leave this. Tell the user what you ` +
                    `wanted to hand over and who you wanted to hand it to.`,
                } satisfies Output

              // Admitted through the SAME seam every other input uses (`SessionInput.admit`), not a
              // private path: one door for "a turn was requested" is what keeps provenance, ordering
              // and the durable event log honest for a message that did not come from a person.
              //
              // ⚠️ `SessionV2.Service` is deliberately NOT used here even though it wraps these two
              // calls: the full session service pulls the runner in, and a tool depending on the
              // runner is a cycle in the location graph — measured, it broke the type-check of five
              // unrelated modules.
              yield* SessionInput.admit(db, events, {
                id: SessionMessage.ID.create(),
                sessionID: chat.id as never,
                prompt: {
                  text: input.message,
                  files: [],
                  agents: [],
                  // PEER, not parent: the receiving model is told a colleague is asking, not that
                  // work has been assigned to it from above. `session/origin.ts` renders both.
                  origin: { via: "agent", sessionID: context.sessionID, label: selfID || undefined, relation: "peer" },
                },
                delivery: "queue",
              }).pipe(Effect.orDie)
              // …and the colleague is WOKEN. A durable-but-dormant hand-off is the "stored and not
              // live" defect this codebase keeps re-finding: the message would sit in their queue
              // until somebody happened to open their chat.
              // Strictly AFTER the admit: the executor's drain reads the queued row from the
              // database, so waking first is a race that ends in an empty turn (`spawner.ts` learned
              // this). `wake` coalesces and never fails, so a live hand-off cannot report failure
              // for a message that did land.
              const started = yield* wake.wake(chat.id as never)

              return {
                ok: true,
                message: started
                  ? `Left it with ${target}, in their own chat, and they have started on it. They answer there, in ` +
                    `their own time — this does not wait for them, so finish what you can and tell the user who ` +
                    `has it.`
                  : // Durable but dormant, and SAID so: nothing in this process will run their turn,
                    // so a caller that reported "handed over" would be promising a reply nobody is
                    // going to write.
                    `Left it with ${target}, but nothing is running their chat right now, so it will wait until ` +
                    `someone opens it. Tell the user it is queued rather than under way.`,
              } satisfies Output
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                // A DENIAL reaches the model as the denial — the deny-fast wording tells an
                // unattended run not to wait for an answer nobody will give. Same rule as `spawn`.
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: "Unable to reach that colleague." })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/colleague",
  layer,
  deps: [
    ToolRegistry.node,
    AgentV2.node,
    SessionRunCoordinator.wakeNode,
    PermissionV2.node,
    Database.node,
    EventV2.node,
  ],
})
