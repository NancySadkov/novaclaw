export * as SpawnTool from "./spawn"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { AgentV2 } from "../agent"
import { SessionSpawner } from "../session/spawner"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// Spawn a CHILD session — the OS `fork` (architecture.md Phase 3 step 6). A thin location tool over
// the `SessionSpawner` seam: the child carries this session as its `parentID` (so it inherits
// agent/model/system-prompt/permissions via `resolveSessionConfig` unless overridden) and starts on
// the enqueued prompt when the coordinator next runs it. Guarded by the seam's fork-bomb depth cap.
// TODO: gate behind a "may spawn" permission + flat max-children/rate quotas (todo 1K / Vision);
// TODO: add `exit(result)` + `wait(childID)` (needs step 5's SessionCompleted) to complete the lifecycle.

export const name = "spawn"

export const Input = Schema.Struct({
  prompt: Schema.String.annotate({ description: "The task / opening message for the new child agent session." }),
  agent: Schema.String.pipe(Schema.optional).annotate({
    description: 'Optional agent for the child (e.g. "plan", "build"). Omit to inherit this session\'s agent.',
  }),
  systemPromptOverride: Schema.String.pipe(Schema.optional).annotate({
    description: "Optional system-prompt override for the child. Omit to inherit this session's prompt.",
  }),
})

const StructuredOutput = Schema.Struct({
  childID: Schema.String.pipe(Schema.optional),
  limited: Schema.Boolean.pipe(Schema.optional),
})

const Output = Schema.Struct({
  ...StructuredOutput.fields,
  message: Schema.String,
})
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const spawner = yield* SessionSpawner.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Spawn a child agent session (a fork) with its own context that runs the given prompt. The child " +
            "inherits this session's agent/model/system-prompt/permissions unless overridden, and carries this " +
            "session as its parent. Returns the child session id. Use it to delegate an independent sub-task.",
          input: Input,
          output: Output,
          structured: StructuredOutput,
          toStructuredOutput: ({ output }) => ({
            ...(output.childID === undefined ? {} : { childID: output.childID }),
            ...(output.limited === undefined ? {} : { limited: output.limited }),
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            spawner
              .spawn({
                parentID: context.sessionID,
                text: input.prompt,
                agent: input.agent ? AgentV2.ID.make(input.agent) : undefined,
                systemPromptOverride: input.systemPromptOverride,
              })
              .pipe(
                Effect.map(
                  (childID): Output => ({
                    childID,
                    message: `Spawned child session ${childID}; it will run its prompt on the next scheduler cycle.`,
                  }),
                ),
                // Fork-bomb guard tripped: inform the model (a denial-as-observation, never a halt).
                Effect.catchTag(
                  "SessionSpawner.LimitError",
                  (error): Effect.Effect<Output> =>
                    Effect.succeed({
                      limited: true,
                      message: {
                        depth: `Spawn refused: the session chain is already ${error.depth} deep (max ${error.limit}). Do the sub-task in this session instead of spawning deeper.`,
                        children: `Spawn refused: this session already has ${error.depth} children (max ${error.limit}). Reuse or wait on existing children instead of spawning more.`,
                        rate: `Spawn refused: ${error.depth} spawns in the last minute (max ${error.limit}). Slow down — wait on the children you already spawned.`,
                      }[error.reason],
                    }),
                ),
                Effect.mapError(() => new ToolFailure({ message: "Unable to spawn child session." })),
              ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/spawn",
  layer,
  deps: [ToolRegistry.node, SessionSpawner.node],
})
