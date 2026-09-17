export * as MemoSetTool from "./memo-set"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Durable } from "../session/durable"
import { PermissionV2 } from "../permission"
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
 * The logic lives in `memo.ts` (the two schemas, the item plumbing, the permission charge, the refusal
 * mapping). This file is the registration, its prose, and its node.
 */

export const name = "memo_set"

export const metadata = {
  description:
    "Keep a short named item in this session's memo area: a place for the handful of facts that must " +
    "survive a context rewrite (a path that matters, a decision already made, what the user is waiting " +
    `for). The area holds at most ${Durable.DURABLE_ITEMS_MAX} items and is rebuilt into your system ` +
    "prompt after each compaction, so a write here reaches the prompt from the next rewrite onwards — read " +
    'it back sooner with the `session` tool (`kind: "durable"`). Reusing a name replaces that item. ' +
    "Nothing is evicted for you: clear what you no longer need with `memo_clear`.",
  input: MemoTool.SetInput,
  output: MemoTool.Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const components = yield* SessionComponentRegistry.Service
    const permission = yield* PermissionV2.Service
    const deps: MemoTool.Deps = { components, permission }

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
  // `PermissionV2.node` is here because the charge is what makes the kind's `consequential` tier real —
  // a tier with no checkout is a price nobody pays. See `memo.ts`'s header.
  deps: [ToolRegistry.node, PermissionV2.node, SessionComponentRegistry.node],
})
