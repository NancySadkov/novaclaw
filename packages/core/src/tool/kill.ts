export * as KillTool from "./kill"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { ColleagueHandoff } from "../session/colleague-handoff"
import { SessionSchema } from "../session/schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "kill"

export const Input = Schema.Struct({
  sessionID: SessionSchema.ID.annotate({
    description: "The direct child worker session id returned by `spawn`.",
  }),
})

const Output = Schema.Struct({ message: Schema.String, archived: Schema.Number })
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const handoff = yield* ColleagueHandoff.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Terminate one of your direct spawned workers immediately. Its chat and every descendant worker chat " +
            "are archived rather than deleted. Use this when a worker is stuck, wrong, or no longer needed.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            handoff.killWorker({ from: context.sessionID, worker: input.sessionID }).pipe(
              Effect.flatMap(
                (outcome): Effect.Effect<Output, ToolFailure> =>
                  outcome.ok
                    ? Effect.succeed({
                        archived: outcome.archived ?? 0,
                        message:
                          `Terminated worker ${input.sessionID} and archived ${outcome.archived ?? 0} ` +
                          `worker transcript${outcome.archived === 1 ? "" : "s"}.`,
                      })
                    : Effect.fail(
                        new ToolFailure({
                          message: outcome.reason ?? "That session is not one of your direct spawned workers.",
                        }),
                      ),
              ),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/kill",
  layer,
  deps: [ToolRegistry.node, ColleagueHandoff.node],
})
