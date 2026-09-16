export * as DurableClearTool from "./durable-clear"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SessionComponentRegistry } from "../session/component-registry"
import { DurableTool } from "./durable"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `durable_clear` — remove one item from the session's durable area by name.
 *
 * The other half of {@link DurableSetTool}, and its own file for the reason recorded there: the
 * deferred-manifest generator describes ONE tool per module, so a file registering two cannot be
 * represented as a schema-only registration.
 *
 * ⚠️ Nothing evicts automatically, which is what makes this the way room is made at the limit.
 * `durable_set`'s refusal lists what is IN the area and points here, because the owner's rule is that
 * the colleague keeps the ten most IMPORTANT items — importance is the agent's judgement, and a harness
 * that silently drops the oldest to make room is one that deletes a fact the agent chose to keep.
 */

export const name = "durable_clear"

export const metadata = {
  description:
    "Remove one item from this session's durable area by name. Nothing is evicted automatically, so this is " +
    "how room is made once the area is full. The item leaves the shadow immediately; the block in your " +
    "system prompt drops it at the next compaction.",
  input: DurableTool.ClearInput,
  output: DurableTool.Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const permission = yield* PermissionV2.Service
    const deps: DurableTool.Deps = { components, permission }

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input, context) =>
              DurableTool.clearDurable(deps, input, context).pipe(Effect.mapError(DurableTool.toFailure)),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/durable-clear",
  layer,
  deps: [ToolRegistry.node, PermissionV2.node, SessionComponentRegistry.node],
})
