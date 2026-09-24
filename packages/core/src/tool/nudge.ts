export * as NudgeTool from "./nudge"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { AgentV2 } from "../agent"
import { ConfigNudge } from "../config/nudge"
import { ConfigAgent } from "../config/agent"
import { TIER_ACTION } from "../config-tier"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { NudgeService } from "../nudge-service"

export const name = "nudge"
const Target = Schema.String.pipe(Schema.optional)

export const Input = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list"), target: Target }),
  Schema.Struct({ op: Schema.Literal("view"), id: Schema.String, target: Target }),
  Schema.Struct({ op: Schema.Literals(["add", "edit"]), target: Target, nudge: ConfigNudge.Info }),
  Schema.Struct({ op: Schema.Literals(["delete", "disable", "enable"]), id: Schema.String, target: Target }),
  Schema.Struct({ op: Schema.Literal("confirm"), id: Schema.String, callId: Schema.String }),
])
export const Output = Schema.String

export const description =
  "List, view, add, edit, enable, disable, or delete personal Nudges for yourself or an officer below you in the reporting chain. A nudge may run a bounded bash command in $(...) at delivery. Before-tool nudges require nudge confirm before retrying the same call."

export const metadata = { description, input: Input, output: Output, sideEffect: "idempotent-write" } as const
const failure = (message: string) => new ToolFailure({ message })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const agents = yield* AgentConfigStore.Service
    const roster = yield* AgentV2.Service
    const permission = yield* PermissionV2.Service
    const nudges = yield* NudgeService.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            execute: (input, context) =>
              Effect.gen(function* () {
                const self = String(context.agent)
                if (input.op === "confirm") {
                  const accepted = yield* nudges.confirmBefore({ sessionID: context.sessionID, agentID: self, id: input.id, callID: input.callId })
                  if (!accepted) return yield* failure("That blocked call is unavailable or expired. Retry the intended call to receive a fresh nudge.")
                  return "Confirmed. Retry the same tool call with the same arguments to proceed."
                }
                const requestedTarget = "target" in input ? input.target : undefined
                const target = requestedTarget ?? self
                const colleagues = yield* roster.all()
                const byID = new Map(colleagues.map((agent) => [String(agent.id), agent]))
                let cursor = byID.get(target)
                let authorized = target === self
                const visited = new Set<string>()
                while (!authorized && cursor && !visited.has(String(cursor.id))) {
                  visited.add(String(cursor.id))
                  const superior = String(cursor.superior ?? AgentV2.NOVA_ID)
                  authorized = superior === self
                  cursor = byID.get(superior)
                }
                if (!authorized)
                  return yield* failure("Nothing changed: you may manage only your own nudges and those of officers below you.")

                const allAgentLayers = yield* agents.agents()
                const configured = yield* agents.configured()
                const readPersonal = (id: string) => AgentConfigStore.fold(configured[id] ?? [])

                if (input.op === "list") {
                  const personal = readPersonal(target)?.nudges ?? []
                  return JSON.stringify({ personal: { agent: target, nudges: personal } })
                }
                if (input.op === "view") {
                  const found = (readPersonal(target)?.nudges ?? []).find((item) => item.id === input.id)
                  if (!found) return yield* failure(`No personal nudge named ${input.id}.`)
                  return JSON.stringify(found)
                }

                const resource = `personal:${target}`
                yield* permission
                  .assert({
                    action: TIER_ACTION.privileged,
                    resources: [resource],
                    save: [resource],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.mapError((error) => failure(PermissionV2.denialMessage(error) ?? String(error))))

                const writePersonal = (id: string, patch: { nudges?: readonly ConfigNudge.Info[] }) =>
                  Effect.gen(function* () {
                    const layers = allAgentLayers[id]
                    if (!layers?.length && id !== AgentV2.NOVA_ID) return yield* failure(`No officer named ${id}.`)
                    if (!layers?.length) {
                      yield* agents.setLayers(id, [{ ...patch } as ConfigAgent.Info])
                      return
                    }
                    const last = layers.at(-1)!
                    yield* agents.setLayers(id, [...layers.slice(0, -1), { ...last, ...patch }])
                  })

                const current = readPersonal(target)?.nudges ?? []
                let next: readonly ConfigNudge.Info[]
                if (input.op === "delete") {
                  if (!current.some((item) => item.id === input.id))
                    return yield* failure(`No personal nudge named ${input.id}.`)
                  next = current.filter((item) => item.id !== input.id)
                } else if (input.op === "disable" || input.op === "enable") {
                  if (!current.some((item) => item.id === input.id))
                    return yield* failure(`No personal nudge named ${input.id}.`)
                  next = current.map((item) => item.id === input.id ? { ...item, enabled: input.op === "enable" } : item)
                } else if ("nudge" in input && input.op === "add") {
                  if (current.some((item) => item.id === input.nudge.id))
                    return yield* failure(`A personal nudge named ${input.nudge.id} already exists.`)
                  next = [...current, input.nudge]
                } else if ("nudge" in input) {
                  if (!current.some((item) => item.id === input.nudge.id))
                    return yield* failure(`No personal nudge named ${input.nudge.id}.`)
                  next = current.map((item) => (item.id === input.nudge.id ? input.nudge : item))
                } else {
                  return yield* failure("Unsupported nudge operation.")
                }
                yield* writePersonal(target, { nudges: next })
                return `${target}'s personal nudges updated.`
              }),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/nudge",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, AgentConfigStore.node, AgentV2.node, NudgeService.node],
})
