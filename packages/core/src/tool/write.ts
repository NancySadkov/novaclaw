/**
 * Model-facing V2 file-write leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as WriteTool from "./write"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import fs from "fs/promises"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write"

// TODO: Revisit whether model-facing mutation schemas should prefer absolute `filePath` naming for trained-in compatibility after evaluating model behavior.
export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to write. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  content: Schema.String.annotate({ description: "Content to write to the file" }),
})

export const Output = Schema.Struct({
  operation: Schema.Literal("write"),
  target: Schema.String,
  resource: Schema.String,
  existed: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.existed ? "Wrote" : "Created"} file successfully: ${output.resource}`

/** Deferred V2 write UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description:
              "Write content to one file. Prefer `edit` for any change short of a full rewrite — every rewrite is a fresh chance to introduce a typo, and wholesale overwrites can be denied by permission mode. Known failure mode: content beyond a few hundred lines can be truncated by the model server mid-stream, breaking the call — build any large NEW file in chunks from the FIRST call (write the head, then append parts with bash `cat >> path <<'EOF'`), and never retry a truncated whole-file write through any tool. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
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
                const target = yield* mutation.resolve({ path: input.path, kind: "file" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external, "write"),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                // 1I: creating a NEW file and overwriting an existing one WHOLESALE are distinct
                // actions, so a mode (1K "surgical") can permit edits + new files while denying
                // full rewrites — the classic small-model failure of regenerating a whole file.
                const existed = yield* Effect.promise(() =>
                  fs.access(target.canonical).then(
                    () => true,
                    () => false,
                  ),
                )
                yield* permission.assert({
                  action: existed ? "write" : "create",
                  resources: [target.resource],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                return yield* files.writeTextPreservingBom({ target, content: input.content })
              }).pipe(
                Effect.mapError((error) => {
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({ message: `Unable to write ${input.path}` })
                }),
              ),
          }),
          "write",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, PermissionV2.node],
})
