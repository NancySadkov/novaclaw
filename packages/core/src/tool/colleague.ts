export * as ColleagueTool from "./colleague"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ColleagueHandoff } from "../session/colleague-handoff"
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
// ⚠️ **The delivery happens on the HOST, and that is not an implementation detail.** A session runs
// in its own worker process, and `session-worker/event-bridge.ts` refuses — by design — to publish an
// event whose session id is not that worker's lease: a worker must not be able to write into anyone
// else's transcript. Measured before the crossing existed, the first version of this tool came back
// *"session event does not belong to this worker"*. `ColleagueHandoff` is the seam; inside a worker
// it rides `colleague-ask`, and the SENDER is stamped from the lease host-side, so a worker can
// speak as itself and as nobody else.
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

const HireOp = Schema.Struct({
  op: Schema.Literal("hire"),
  title: Schema.String.annotate({
    description: 'The job, in two or three words: "Bookkeeper", "Talent Scout". Not "Helper".',
  }),
  brief: Schema.String.annotate({
    description:
      "What this colleague owns, and what it must never do without asking. This is its standing " +
      "instruction — it outlives every conversation, so write it for the job, not for today.",
  }),
  personality: Schema.String.pipe(Schema.optional).annotate({
    description: "How it should speak and carry itself. Optional.",
  }),
})

const RetireOp = Schema.Struct({
  op: Schema.Literal("retire"),
  colleague: Schema.String.annotate({ description: "Which colleague to retire, by id." }),
})

export const Input = Schema.Union([ListOp, AskOp, HireOp, RetireOp])

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

/**
 * Hiring and retiring are the CEO's job and nobody else's (AGENTS.md — the structural metaphor:
 * Nova "creates the role when none exists, and retires one that no longer earns its keep").
 *
 * ⚠️ Enforced here as WELL as by permission rules, and the two are not redundant. A rule is the
 * operator's dial and can be widened; this is the org chart itself — an officer that could hire
 * would be a second CEO, and an org with two CEOs has none. The permission check still runs, because
 * "Nova may do this" and "this instance allows it right now" are different questions.
 */
export const mayStaff = (selfID: string): boolean => selfID === AgentV2.NOVA_ID

/** Colleagues you can address: the roster, minus the staff and the machinery, minus yourself. */
export const addressable = (agents: ReadonlyArray<AgentV2.Info>, selfID: string): ReadonlyArray<AgentV2.Info> =>
  agents.filter((agent) => agent.mode !== "subagent" && !agent.hidden && agent.id !== selfID)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    // ONE seam for the delivery, whichever side of the worker boundary this tool is running on:
    // host-direct in-process, or over `colleague-ask` when a worker provides the bridge client.
    const handoff = yield* ColleagueHandoff.Service

    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Your colleagues — the other named agents on this instance, each with its own chat, memory and job. " +
            "`list` shows who works here and what they own. `ask` hands one of them a piece of work; they answer " +
            "in their own chat, in their own time, and this does not wait for them. Use it instead of doing " +
            "someone else's job, and instead of `spawn` when the work belongs to a role that already exists. " +
            "`hire` and `retire` staff the organization and are Nova's alone — a hire is given a name from the " +
            "instance's own pool, so colleagues never read as people.",
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

              if (input.op === "hire" || input.op === "retire") {
                // The org chart, before the permission dial: an officer that could hire would be a
                // second CEO, and an organization with two CEOs has none.
                if (!mayStaff(selfID))
                  return yield* new ToolFailure({
                    message:
                      "Only Nova hires and retires colleagues. Say what role you think is missing, or who is no " +
                      "longer needed, and let the user or Nova decide.",
                  })
                yield* permission.assert({
                  action: name,
                  resources: [input.op === "hire" ? "hire" : `retire:${input.colleague}`],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: {
                    type: "tool" as const,
                    messageID: context.assistantMessageID,
                    callID: context.toolCallID,
                  },
                })
              }

              if (input.op === "hire") {
                // The whole act — draw a name, write the role, make it LIVE — happens through the
                // host seam. The first version wrote the store from inside the worker and reloaded
                // the WORKER's roster: `Procius` existed durably and `GET /api/agent` did not list
                // him. A colleague nobody can see is a colleague nobody can talk to.
                const hired = yield* handoff.hire({
                  title: input.title,
                  brief: input.brief,
                  ...(input.personality === undefined ? {} : { personality: input.personality }),
                })
                return {
                  ok: true,
                  message:
                    `Hired ${hired.name} (id \`${hired.id}\`) as ${input.title}. They have no chat yet — open them ` +
                    `in Contacts to start one, or tell the user who they now have.`,
                } satisfies Output
              }

              if (input.op === "retire") {
                const target = input.colleague.trim()
                if (AgentV2.isProtected(target))
                  return yield* new ToolFailure({
                    message: `"${target}" is this instance's governing agent and cannot be retired.`,
                  })
                const roster = yield* agents.all()
                if (!addressable(roster, selfID).some((agent) => String(agent.id) === target))
                  return yield* new ToolFailure({
                    message: `No colleague called "${target}" — call \`list\` before retiring anyone.`,
                  })
                yield* handoff.retire(target)
                return {
                  ok: true,
                  message:
                    // Precise, because this sentence is the only account of the act the user gets and
                    // the two halves genuinely differ: the transcript is archived (recoverable), the
                    // private memories are deleted (not). Saying "goes with them" of both was true of
                    // neither until 2026-08-21, and remains wrong about the chat.
                    `Retired ${target}. Their chat is archived and what they remembered is set aside, so nobody ` +
                    `inherits it — the name goes back into the pool. Tell the user what they used to own, in case ` +
                    `it needs a new owner.`,
                } satisfies Output
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

              const outcome = yield* handoff.deliver({
                from: context.sessionID,
                colleague: target,
                message: input.message,
              })
              if (!outcome.delivered)
                return {
                  ok: false,
                  // A colleague with no chat is not an error the model can fix by retrying, and
                  // silently starting one on their behalf would put words in a conversation the user
                  // has never seen. Say what is true and let the turn continue.
                  message:
                    `${target} has no open chat yet, so there is nowhere to leave this. Tell the user what you ` +
                    `wanted to hand over and who you wanted to hand it to.`,
                } satisfies Output

              return {
                ok: true,
                // 🔴 What the sender may promise, and what it may not.
                //
                // Measured on a live officer-to-officer hand-off 2026-08-21: told only that the
                // colleague "answers there, in their own time", the sender told the USER *"Once they
                // respond in their chat, I'll relay the answer to you"* — and at that point nothing
                // could deliver it. The route back exists now (`colleague-note.ts` rides a return
                // address in with the message), so the honest sentence is neither the old promise nor
                // the flat denial that replaced it: the answer arrives HERE, LATER, as a message from
                // them, and this turn must not wait for it.
                message: outcome.started
                  ? `Left it with ${target}, in their own chat, and they have started on it. Their answer will ` +
                    `arrive HERE as a message from them — later, in their own time. Do NOT wait for it and do not ` +
                    `stall this turn: finish what you can do yourself and tell the user who has the rest.`
                  : // Durable but dormant, and SAID so: nothing is running their chat, so a caller
                    // reporting "handed over" would promise a reply nobody is going to write.
                    `Left it with ${target}, but nothing is running their chat right now, so it waits until someone ` +
                    `opens it. Their answer will arrive here if and when they write it. Tell the user it is queued ` +
                    `with that colleague rather than under way, and do not wait for it.`,
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
  deps: [ToolRegistry.node, AgentV2.node, ColleagueHandoff.node, PermissionV2.node],
})
