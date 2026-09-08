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
import { TrashSettings } from "../trash-settings"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "trash"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File or directory to delete SAFELY (moved to a restorable Trash for the configured retention period). Relative paths resolve within the active Location. Prefer this over `bash rm` for any deletion.",
  }),
})

export const Output = Schema.Struct({
  id: Schema.String,
  originalPath: Schema.String,
  type: Schema.Literals(["file", "directory"]),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `Moved ${output.type} to trash (restorable for about ${TrashSettings.retentionDays()} days): ${output.id}`

export const metadata = {
  sideEffect: "idempotent-write",
  description:
    "Safely delete a file or directory: moves it into a dated Trash store (restorable for the configured retention period) instead of destroying it. ALWAYS prefer this over `rm`/`del` in bash — the user can restore trashed items, and so can you if a deletion turns out wrong. Returns the trash id needed to restore.",
  input: Input,
  output: Output,
} as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                // `readsContent: false` — moving a file to the Trash does not put its bytes in front of the
                // model, and "Never read" is not "never delete". The deletion itself is gated by the
                // permission evaluator, which is the seam that owns destructive acts.
                const target = yield* mutation.resolve({ path: input.path, readsContent: false })
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
                  targets: [{ resource: target.resource, canonical: target.canonical }],
                  attachmentPaths: [...(context.attachmentPaths ?? [])],
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
