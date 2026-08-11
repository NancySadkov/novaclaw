export * as UpgradeChatTool from "./upgrade-chat"

import { DateTime, Effect, Layer, Schema } from "effect"
import { ToolFailure } from "@novaclaw/llm"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { PermissionV2 } from "../permission"
import { SessionEvent } from "../session/event"
import { SessionMessage } from "../session/message"
import { SessionStore } from "../session/store"
import { ShortChat } from "../session/runner/short-chat"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = ShortChat.UPGRADE_TOOL
export const Input = Schema.Struct({})
export const Output = Schema.Struct({ upgraded: Schema.Boolean, message: Schema.String })
export type Output = typeof Output.Type

export const SUCCESS =
  "Agent is now enabled. Continue the user's pending request with the restored project context and tools."

export const runUpgrade = <E, R>(input: {
  readonly approve: Effect.Effect<void, E, R>
  readonly exists: Effect.Effect<boolean>
  readonly publish: Effect.Effect<void>
}) =>
  Effect.gen(function* () {
    yield* input.approve
    if (!(yield* input.exists)) return yield* Effect.fail(new ToolFailure({ message: "This chat no longer exists." }))
    yield* input.publish
    return { upgraded: true as const, message: SUCCESS }
  })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const sessions = yield* SessionStore.Service
    const events = yield* EventV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Ask the user to upgrade this short conversation to Agent, restoring project context and tools for the pending request.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (_, context) =>
            runUpgrade({
              // Never save this approval: each conversation upgrade is a fresh, visible decision.
              approve: permission.assert({
                action: "chat_upgrade",
                resources: ["shortChat"],
                save: [],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              }),
              exists: sessions.get(context.sessionID).pipe(Effect.map((session) => session !== undefined)),
              publish: DateTime.now.pipe(
                Effect.flatMap((timestamp) =>
                  events.publish(SessionEvent.FeatureSwitched, {
                    sessionID: context.sessionID,
                    messageID: SessionMessage.ID.create(),
                    timestamp,
                    feature: "shortChat",
                    enabled: false,
                  }),
                ),
              ),
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const denial = PermissionV2.denialMessage(error)
                return new ToolFailure({ message: denial ?? "This chat was not upgraded." })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/upgrade-chat",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionStore.node, EventV2.node],
})
