export * as NudgeTool from "./nudge"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { AgentV2 } from "../agent"
import { ConfigNudge } from "../config/nudge"
import { TIER_ACTION } from "../config-tier"
import { makeLocationNode } from "../effect/app-node"
import { Nudge } from "../nudge"
import { PermissionV2 } from "../permission"
import { SettingsConfigStore } from "../settings-config-store"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "nudge"
const Scope = Schema.Literals(["global", "personal"])
const Target = Schema.String.pipe(Schema.optional)

export const Input = Schema.Union([
  Schema.Struct({ op: Schema.Literal("list"), scope: Scope.pipe(Schema.optional), target: Target }),
  Schema.Struct({ op: Schema.Literal("view"), id: Schema.String, scope: Scope, target: Target }),
  Schema.Struct({ op: Schema.Literals(["add", "edit"]), scope: Scope, target: Target, nudge: ConfigNudge.Info }),
  Schema.Struct({ op: Schema.Literal("delete"), id: Schema.String, scope: Scope, target: Target }),
  Schema.Struct({ op: Schema.Literal("set_global"), enabled: Schema.Boolean, target: Target }),
])
export const Output = Schema.String

export const description =
  "List, view, add, edit, or delete configurable Nudges. Global nudges apply to every officer that has not opted out; personal nudges belong only to one officer. Nova may manage global or any officer's personal nudges. Other officers may manage only their own personal nudges and may opt themselves in or out of global nudges. A nudge can use a new-day, time, tool, file, compaction, resource, or script hook; its optional script appends bounded dynamic stdout at delivery time."

export const metadata = { description, input: Input, output: Output, sideEffect: "idempotent-write" } as const
const failure = (message: string) => new ToolFailure({ message })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const settings = yield* SettingsConfigStore.Service
    const agents = yield* AgentConfigStore.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            execute: (input, context) =>
              Effect.gen(function* () {
                const self = String(context.agent)
                const requestedTarget = "target" in input ? input.target : undefined
                const target = requestedTarget ?? self
                const scope = "scope" in input ? input.scope : undefined
                if (self !== AgentV2.NOVA_ID && (scope === "global" || target !== self))
                  return yield* failure("Nothing changed: an officer may manage only its own personal nudges.")

                const allAgentLayers = yield* agents.agents()
                const storedGlobal = (yield* settings.all()).nudges
                const globalNudges = (storedGlobal === undefined ? Nudge.defaults() : storedGlobal) as readonly ConfigNudge.Info[]
                const readPersonal = (id: string) => AgentConfigStore.fold(allAgentLayers[id] ?? [])
                const readGlobal = () => globalNudges
                const selected = (which: "global" | "personal", id: string): readonly ConfigNudge.Info[] =>
                  which === "global" ? readGlobal() : readPersonal(id)?.nudges ?? []

                if (input.op === "list") {
                  const effectiveScope = self === AgentV2.NOVA_ID ? input.scope : "personal"
                  const global = effectiveScope === "personal" ? [] : readGlobal()
                  const personal = effectiveScope === "global" ? [] : readPersonal(target)?.nudges ?? []
                  return JSON.stringify({
                    ...(effectiveScope === "personal" ? {} : { global }),
                    ...(effectiveScope === "global" ? {} : { personal: { agent: target, nudges: personal } }),
                    globalEnabled: readPersonal(target)?.globalNudges !== false,
                  })
                }
                if (input.op === "view") {
                  const found = selected(input.scope, target).find((item) => item.id === input.id)
                  if (!found) return yield* failure(`No ${input.scope} nudge named ${input.id}.`)
                  return JSON.stringify(found)
                }

                const resource = input.op === "set_global" ? `agent:${target}` : `${input.scope}:${target}`
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

                const writePersonal = (id: string, patch: { nudges?: readonly ConfigNudge.Info[]; globalNudges?: boolean }) =>
                  Effect.gen(function* () {
                    const layers = allAgentLayers[id]
                    if (!layers?.length) return yield* failure(`No officer named ${id}.`)
                    const last = layers.at(-1)!
                    yield* agents.setLayers(id, [...layers.slice(0, -1), { ...last, ...patch }])
                  })
                if (input.op === "set_global") {
                  yield* writePersonal(target, { globalNudges: input.enabled })
                  return `Global nudges are now ${input.enabled ? "enabled" : "disabled"} for ${target}.`
                }

                const current = selected(input.scope, target)
                let next: readonly ConfigNudge.Info[]
                if (input.op === "delete") {
                  if (!current.some((item) => item.id === input.id))
                    return yield* failure(`No ${input.scope} nudge named ${input.id}.`)
                  next = current.filter((item) => item.id !== input.id)
                } else if (input.op === "add") {
                  if (current.some((item) => item.id === input.nudge.id))
                    return yield* failure(`A ${input.scope} nudge named ${input.nudge.id} already exists.`)
                  next = [...current, input.nudge]
                } else {
                  if (!current.some((item) => item.id === input.nudge.id))
                    return yield* failure(`No ${input.scope} nudge named ${input.nudge.id}.`)
                  next = current.map((item) => (item.id === input.nudge.id ? input.nudge : item))
                }
                if (input.scope === "global") yield* settings.set("nudges", [...next])
                else yield* writePersonal(target, { nudges: next })
                return `${input.scope === "global" ? "Global" : `${target}'s personal`} nudges updated.`
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
  deps: [ToolRegistry.node, PermissionV2.node, SettingsConfigStore.node, AgentConfigStore.node],
})
