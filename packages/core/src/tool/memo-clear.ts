export * as MemoClearTool from "./memo-clear"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionComponentRegistry } from "../session/component-registry"
import { MemoTool } from "./memo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `memo_clear` — remove one item from this session's memo area by name.
 *
 * The other half of {@link MemoSetTool}: renamed from `durable_clear` and resident for the same
 * reason (`memo.ts`'s header).
 *
 * ⚠️ Nothing evicts automatically, which is what makes this the way room is made at the limit.
 * `memo_set`'s refusal lists what is IN the area and points here, because the owner's rule is that
 * the colleague keeps the ten most IMPORTANT items — importance is the agent's judgement, and a harness
 * that silently drops the oldest to make room is one that deletes a fact the agent chose to keep.
 */

export const name = "memo_clear"

export const metadata = {
  description:
    "Remove one item from this session's memo area by name. Nothing is evicted automatically, so this is " +
    "how room is made once the area is full. The item leaves the shadow immediately; the block in your " +
    "system prompt drops it at the next compaction.",
  input: MemoTool.ClearInput,
  output: MemoTool.Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const deps: MemoTool.Deps = { components }

    yield* tools
      .register({
        [name]: Tool.make({
          ...metadata,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            MemoTool.clearMemo(deps, input, context).pipe(Effect.mapError(MemoTool.toFailure)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memo-clear",
  layer,
  // No `PermissionV2.node`: the clear is the agent's own memory, and no tier charges it (`memo.ts`).
  deps: [ToolRegistry.node, SessionComponentRegistry.node],
})
