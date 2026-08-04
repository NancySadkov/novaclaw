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
        [name]: Tool.make({
          sideEffect: "idempotent-write",
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
              const current = yield* Effect.promise(() =>
                fs.readFile(target.canonical).then(
                  (content) => content,
                  (error: NodeJS.ErrnoException) => {
                    if (error.code === "ENOENT") return undefined
                    throw error
                  },
                ),
              )
              const existed = current !== undefined
              yield* permission.assert({
                action: existed ? "write" : "create",
                resources: [target.resource],
                targets: [{ resource: target.resource, canonical: target.canonical }],
                attachmentPaths: [...(context.attachmentPaths ?? [])],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const content = preserveBom(input.content, current)
              return yield* current
                ? files.writeIfUnchanged({ target, expected: current, content })
                : files.create({ target, content })
            }).pipe(
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                if (
                  error instanceof FileMutation.StaleContentError ||
                  error instanceof FileMutation.TargetExistsError
                ) {
                  return new ToolFailure({
                    message: "File changed after permission approval. Read it again before writing.",
                  })
                }
                return new ToolFailure({ message: `Unable to write ${input.path}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, PermissionV2.node],
})

function preserveBom(content: string, current: Uint8Array | undefined) {
  const stripped = content.replace(/^\uFEFF+/, "")
  const needsBom = stripped.length !== content.length || Boolean(current && hasUtf8Bom(current))
  return needsBom ? `\uFEFF${stripped}` : stripped
}

function hasUtf8Bom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}
