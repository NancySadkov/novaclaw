export * as DurableSetTool from "./durable-set"

import { Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Durable } from "../session/durable"
import { PermissionV2 } from "../permission"
import { SessionComponentRegistry } from "../session/component-registry"
import { DurableTool } from "./durable"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * `durable_set` — keep one short named item in the session's durable area.
 *
 * Owner, 2026-09-16: *"This context area stores named entries set by either harness or the agent itself
 * using `durable_set Name Value` and `durable_clear Name` tools … The area is limited to 10 items (Name
 * can't be longer than 30 chars, Value can't be longer than 512 chars) and updated only after
 * compaction, from the housekeeped shadow copy."*
 *
 * ⚠️ **One tool per file, and that is a generated-manifest requirement rather than tidiness.**
 * `script/deferred-builtins.ts` reads a single `name` and a single `metadata` out of each tool file to
 * write that tool's schema-only registration. This tool and `durable_clear` shipped in one file first,
 * and the generator refused to run — `Extract schema metadata first: durable.ts` — which is the
 * ratchet doing its job: a deferred file the manifest cannot describe is a tool the worker graph would
 * have to import in full.
 *
 * ⚠️ The logic lives in `durable.ts` (the two schemas, the item plumbing, the permission charge, the
 * refusal mapping). This file is the registration, its prose, and its node.
 */

export const name = "durable_set"

export const metadata = {
  description:
    "Keep a short named item in this session's durable area: a place for the handful of facts that must " +
    "survive a context rewrite (a path that matters, a decision already made, what the user is waiting " +
    `for). The area holds at most ${Durable.DURABLE_ITEMS_MAX} items and is rebuilt into your system ` +
    "prompt after each compaction, so a write here reaches the prompt from the next rewrite onwards — read " +
    'it back sooner with the `session` tool (`kind: "durable"`). Reusing a name replaces that item. ' +
    "Nothing is evicted for you: clear what you no longer need with `durable_clear`.",
  input: DurableTool.SetInput,
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
              DurableTool.setDurable(deps, input, context).pipe(Effect.mapError(DurableTool.toFailure)),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/durable-set",
  layer,
  // `PermissionV2.node` is here because the charge is what makes the kind's `consequential` tier real —
  // a tier with no checkout is a price nobody pays. See `durable.ts`'s header.
  deps: [ToolRegistry.node, PermissionV2.node, SessionComponentRegistry.node],
})
