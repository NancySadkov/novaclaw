export * as TodoWriteTool from "./todowrite"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionTodo } from "../session/todo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "todowrite"

export const Input = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(SessionTodo.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => JSON.stringify(output.todos, null, 2)

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const todos = yield* SessionTodo.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Create and maintain a structured task list for the current coding session. Use it to track progress during multi-step work and keep todo statuses current.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          execute: (input, context) =>
            Effect.gen(function* () {
              yield* permission.assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              yield* todos.update({ sessionID: context.sessionID, todos: input.todos })
              return { todos: input.todos }
            }).pipe(
              // 1J: consult `denialMessage` FIRST so a denial keeps its own identity — including a
              // reject's user feedback and the deny-fast wording an UNATTENDED run needs. The
              // absorber this replaces ignored its error argument, so every refusal reached the
              // model as "Unable to update todos" — indistinguishable from a transient fault, and
              // therefore worth retrying, which is exactly the loop the deny-fast text exists to
              // stop.
              //
              // `assert` is the only thing in this block that can fail: `todos.update` is typed
              // `Effect<void>` (its DB errors are `orDie`'d in `session/todo.ts`), so the channel
              // here is `PermissionV2.Error | SessionV2.NotFoundError`. `denialMessage` answers
              // every member of `PermissionV2.Error`, which leaves a VANISHED SESSION as the only
              // case the fallback below describes — and "Unable to update todos" is true of it
              // without claiming anything about permissions.
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: "Unable to update todos" })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/todowrite",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionTodo.node],
})
