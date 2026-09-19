export * as MemoSetTool from "./memo-set"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Durable } from "../session/durable"
import { SessionComponentRegistry } from "../session/component-registry"
import { MemoTool } from "./memo"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `memo_set` — keep one short named item in this session's memo area.
 *
 * Owner, 2026-09-17: *"Use `memo_set NAME VALUE` and `memo_clear NAME` to set important durable memos
 * surviving compactions."* Renamed from `durable_set`, and RESIDENT (a basic tool like `edit` and
 * `spawn`) rather than deferred: it is named in the system prompt, so a model that has to run
 * `tool_search` to reach a tool the prompt just told it to use is doing the prompt's work.
 *
 * The logic lives in `memo.ts` (the two schemas, the item plumbing, the refusal mapping). This file is
 * the registration, its prose, and its node.
 */

export const name = "memo_set"

export const metadata = {
  description:
    "Keep one short named item in this session's memo area: the handful of facts that must survive a " +
    "context rewrite (a path that matters, a decision already made, what the user is waiting for). " +
    "Context space is extremely valuable, so the area is capped at " +
    `${Durable.DURABLE_ITEMS_MAX} items, a name at ${Durable.DURABLE_NAME_MAX} characters and a value at ` +
    `${Durable.DURABLE_VALUE_MAX}. Reusing a name replaces that item; nothing is evicted for you, so once ` +
    "the area is full call `memo_clear` before `memo_set`. The area is rebuilt into your system prompt " +
    "after each compaction, so a write here reaches the prompt from the next rewrite onwards — read it " +
    'back sooner with the `session` tool (`kind: "durable"`).',
  input: MemoTool.SetInput,
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
            MemoTool.setMemo(deps, input, context).pipe(Effect.mapError(MemoTool.toFailure)),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/memo-set",
  layer,
  // No `PermissionV2.node`: nothing is charged. The limits on this write are the codec's, and the
  // authority question does not arise — the memo area is the colleague's own memory (`memo.ts`).
  deps: [ToolRegistry.node, SessionComponentRegistry.node],
})
