/**
 * Model-facing safe-delete leaf (B8): moves a file or directory into the dated
 * Trash store instead of destroying it — the user can restore to a date, and the
 * agent can self-restore a misfired delete. Relative paths resolve within the
 * active Location; external absolute paths require external_directory approval,
 * exactly like `write`/`edit`.
 */
export * as TrashTool from "./trash"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { trashPath } from "../trash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "trash"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File or directory to delete SAFELY (moved to a restorable Trash, expires ~2 days). Relative paths resolve within the active Location. Prefer this over `bash rm` for any deletion.",
  }),
})

export const Output = Schema.Struct({
  id: Schema.String,
  originalPath: Schema.String,
  type: Schema.Literals(["file", "directory"]),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `Moved ${output.type} to trash (restorable ~2 days): ${output.id}`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Safely delete a file or directory: moves it into a dated Trash store (restorable for ~2 days) instead of destroying it. ALWAYS prefer this over `rm`/`del` in bash — the user can restore trashed items, and so can you if a deletion turns out wrong. Returns the trash id needed to restore.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                const target = yield* mutation.resolve({ path: input.path })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external, "write"),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                yield* permission.assert({
                  action: name,
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const entry = yield* Effect.tryPromise(() => trashPath(target.canonical))
                return { id: entry.id, originalPath: entry.originalPath, type: entry.type }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({
                    message: `Unable to trash ${input.path}: ${error instanceof Error ? error.message : String(error)}`,
                  })
                }),
              ),
          }),
          name,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/trash",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node],
})
