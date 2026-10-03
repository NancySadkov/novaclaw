export * as CoordinationTool from "./coordination"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Coordination } from "../coordination"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { ColleagueHandoff } from "../session/colleague-handoff"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// The coordination task board (AGENTS.md — the structural metaphor: an officer owns a piece of the
// organization's work, and its superior has to be able to see what every report is on).
//
// 🔴 **This is NOT `memo_set`, and the difference is who it is FOR.** A memo is private to the officer
// and dies with the chat. A coordination task is ORGANIZATIONAL state: it survives a Clear, it is
// re-rendered into the officer's own prompt after every compaction, it appears beside each subordinate
// in its superior's prompt, and it is what the owner reads on the Team Chat → Tasks board. That is why
// it lives in its own table keyed by AGENT rather than in the transcript.
//
// ⚠️ **The board is the tier, not the whole company.** `list` shows the officers under one supervisor
// and the supervisor itself — the people whose coordination actually overlaps. A superior may set or
// clear a DIRECT report's task; anyone else's is not theirs to write.

export const name = "coordination"

const ListOp = Schema.Struct({
  op: Schema.Literal("list"),
  supervisor: Schema.optional(
    Schema.String.annotate({
      description: "Whose team to show, by id. Defaults to your own superior (or you when you have none).",
    }),
  ),
})

const SetOp = Schema.Struct({
  op: Schema.Literal("set"),
  task: Schema.String.annotate({
    description:
      "One short line: what you are working on, in your own terms. It is re-read after every " +
      "compaction and shown to your superior and team, so keep it current and concrete.",
  }),
})

const ClearOp = Schema.Struct({
  op: Schema.Literal("clear"),
})

const AssignOp = Schema.Struct({
  op: Schema.Literal("assign"),
  officer: Schema.String.annotate({ description: "A direct report, by id (from `list`)." }),
  task: Schema.String.annotate({
    description: "The task to assign. An empty string clears that officer's task.",
  }),
})

export const Input = Schema.Union([ListOp, SetOp, ClearOp, AssignOp])

const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
type Output = typeof Output.Type

export const toModelOutput = (output: Output) => [{ type: "text" as const, text: output.message }]

const actorName = (agent: AgentV2.Info | undefined, selfID: string): string =>
  agent?.name?.trim() || agent?.title?.trim() || selfID

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentV2.Service
    const handoff = yield* ColleagueHandoff.Service
    const { db } = yield* Database.Service

    /**
     * Tell the officer's team that its task changed, and only when its superior allows it.
     *
     * 🔴 The toggle is read on the SUPERIOR, never on the actor: whether a team is noisy is the
     * team lead's decision, and a subordinate that could silence its own reports upward would make
     * the board depend on who happened to speak. Absent means ON.
     *
     * ⚠️ Best-effort by construction. The task is already durable; a rate-limited or paused recipient
     * is a sentence the caller reads, never a failed write — the board is the fact and the message is
     * the notification.
     */
    const announce = (
      sessionID: SessionSchema.ID,
      selfID: string,
      self: AgentV2.Info,
      verb: string,
    ): Effect.Effect<string> =>
      Effect.gen(function* () {
        const roster = yield* agents.all()
        const superior = AgentV2.resolveSuperior(selfID, self.superior, roster, { includePaused: true })
        if (superior === undefined || AgentV2.kindOf(superior) !== "agent") return ""
        if (superior.teamCoordination === false) return ""
        const peers = AgentV2.directReports(String(superior.id), roster)
          .map((candidate) => String(candidate.id))
          .filter((id) => id !== selfID)
        const recipients = [...new Set([String(superior.id), ...peers])]
        if (recipients.length === 0) return ""
        const message = `[coordination] ${actorName(self, selfID)} ${verb}.`
        if (recipients.length === 1) {
          const outcome = yield* handoff
            .deliver({ from: sessionID, colleague: recipients[0]!, message })
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          return outcome?.delivered === false
            ? ` Could not notify ${recipients[0]}: ${outcome.refused ?? "no reason given"}.`
            : ""
        }
        const outcome = yield* handoff
          .deliverGroup({ from: sessionID, colleagues: recipients, message })
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
        if (outcome === undefined) return " Your team could not be notified."
        const failed = [
          outcome.refused,
          ...(outcome.missing.length > 0 ? [`${outcome.missing.join(", ")} unreachable`] : []),
        ]
          .filter((part) => part !== undefined)
          .join("; ")
        return failed.length > 0 ? ` Some were not notified: ${failed}.` : ""
      })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Your coordination task board — what you and your team are each working on, and how to say " +
            "what you are on. `list` shows the officers under one supervisor (default: your superior) and " +
            "the supervisor itself, each with their task. `set` declares or updates YOUR task; `clear` " +
            "removes it. `assign` sets or clears a DIRECT report's task, and they are told in their own " +
            "chat. Keep your task a short, current line: it is re-read after every compaction and after a " +
            "Clear chat, it appears beside you in your team's prompts, and the owner sees it on the Tasks " +
            "board. A task that no longer describes your work is worse than none.",
          input: Input,
          output: Output,
          structured: Output,
          toStructuredOutput: ({ output }) => ({ ok: output.ok, message: output.message }),
          toModelOutput: ({ output }) => toModelOutput(output),
          execute: (input, context) =>
            Effect.gen(function* () {
              const selfID = String(context.agent ?? "")
              const roster = yield* agents.all()
              const self = roster.find((agent) => String(agent.id) === selfID)
              if (self === undefined || !AgentV2.isColleague(self) || AgentV2.kindOf(self) !== "agent")
                return yield* new ToolFailure({ message: "Only an officer has a coordination task." })

              if (input.op === "list") {
                const configured = AgentV2.resolveSuperior(selfID, self.superior, roster, { includePaused: true })
                const explicit = input.supervisor?.trim()
                const anchor =
                  explicit !== undefined && explicit.length > 0
                    ? explicit
                    : configured !== undefined && AgentV2.kindOf(configured) === "agent"
                      ? String(configured.id)
                      : selfID
                const known = roster.find((agent) => String(agent.id) === anchor)
                if (known === undefined)
                  return yield* new ToolFailure({
                    message: `No officer called "${anchor}" — call \`colleague list\` to see who works here.`,
                  })
                const rows = Coordination.supervisorBoard(roster, new Map(), anchor)
                const tasks = yield* Coordination.taskMap(
                  db,
                  rows.map((row) => row.agent),
                )
                return {
                  ok: true,
                  message: Coordination.format(Coordination.supervisorBoard(roster, tasks, anchor), selfID),
                } satisfies Output
              }

              if (input.op === "set" || input.op === "clear") {
                if (input.op === "set") {
                  const task = input.task.trim()
                  if (task.length === 0)
                    return yield* new ToolFailure({ message: "Name the task, or use `clear` to remove it." })
                  if (task.length > Coordination.TASK_MAX)
                    return yield* new ToolFailure({ message: Coordination.taskTooLongNotice(task.length) })
                  yield* Coordination.put(db, selfID, task)
                  const note = yield* announce(context.sessionID, selfID, self, `set their task: ${task}`)
                  return {
                    ok: true,
                    message:
                      `Task set: "${task}". It is on the team board now, and your system prompt will carry it ` +
                      `after your next compaction.${note}`,
                  } satisfies Output
                }
                yield* Coordination.remove(db, selfID)
                const note = yield* announce(context.sessionID, selfID, self, "cleared their task")
                return {
                  ok: true,
                  message:
                    `Task cleared — it will read "none set yet" in your system prompt after your next ` +
                    `compaction.${note}`,
                } satisfies Output
              }

              const target = input.officer.trim()
              if (target.length === 0)
                return yield* new ToolFailure({ message: "Name the direct report whose task you are setting." })
              if (target === selfID)
                return yield* new ToolFailure({
                  message: "That is you — use `set` for your own task.",
                })
              const report = AgentV2.directReports(selfID, roster).find((agent) => String(agent.id) === target)
              if (report === undefined)
                return yield* new ToolFailure({
                  message:
                    `"${target}" does not report to you, so their task is not yours to set. Call \`list\` ` +
                    `to see your team.`,
                })
              const task = input.task.trim()
              if (task.length === 0) {
                yield* Coordination.remove(db, target)
                const outcome = yield* handoff
                  .deliver({
                    from: context.sessionID,
                    colleague: target,
                    message: `Your coordination task was cleared by ${actorName(self, selfID)} (your superior).`,
                  })
                  .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
                return {
                  ok: true,
                  message:
                    `Cleared the task of ${actorName(report, target)}.` +
                    (outcome?.delivered === true
                      ? " They have been told in their own chat."
                      : " They could not be reached right now — the board still shows it cleared."),
                } satisfies Output
              }
              if (task.length > Coordination.TASK_MAX)
                return yield* new ToolFailure({ message: Coordination.taskTooLongNotice(task.length) })
              yield* Coordination.put(db, target, task)
              const outcome = yield* handoff
                .deliver({
                  from: context.sessionID,
                  colleague: target,
                  message: `Your coordination task was set by ${actorName(self, selfID)} (your superior): ${task}`,
                })
                .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
              return {
                ok: true,
                message:
                  `Set ${actorName(report, target)}'s task: ${task}.` +
                  (outcome?.delivered === true
                    ? " They have been told in their own chat."
                    : " They could not be reached right now — the board still shows it."),
              } satisfies Output
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                return new ToolFailure({ message: "Could not update the coordination board." })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/coordination",
  layer,
  deps: [ToolRegistry.node, Database.node, AgentV2.node, ColleagueHandoff.node],
})
