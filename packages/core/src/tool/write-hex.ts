/**
 * 1L: byte-level patching for binary files — write-hex patches `data` (tolerantly parsed
 * hex text; read-hex output is valid input) at a byte offset, in place, never truncating
 * the rest of the file. The surgical complement to read-hex.
 */
export * as WriteHexTool from "./write-hex"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { parseHexInput } from "./hex"
import { writePatch } from "./hex-io"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "write-hex"

export const Input = Schema.Struct({
  filename: Schema.String.annotate({
    description: "File to patch (created when missing, but only at offset 0). Relative paths resolve within the active Location.",
  }),
  offset: Schema.Number.annotate({
    description: "Byte offset to write at (default 0). At most the current file size — writing AT the size appends.",
  }).pipe(Schema.optional),
  data: Schema.String.annotate({
    description:
      'Hex bytes to write, e.g. "4d 5a 90 00 ; patched header". Anything after ";" on a line is a comment; blank lines and indentation are ignored; a byte may be written as 4d, 0x4d, 4dh or 4d-h.',
  }),
})

export const Output = Schema.Struct({
  bytesWritten: Schema.Number,
  offset: Schema.Number,
  size: Schema.Number,
  created: Schema.Boolean,
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  `${output.created ? "Created file and wrote" : "Patched"} ${output.bytesWritten} bytes @${output.offset}; file is now ${output.size} bytes`

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Patch bytes in a BINARY file at a byte offset (in place — the rest of the file is untouched; writing at the file size appends; a missing file is created only at offset 0). `data` is hex text — canonical input example:\n" +
            "  4d 5a 90 00 03 00 00 00 ; first 8 bytes\n" +
            "  ff fe\n" +
            'Anything after ";" is a comment, blank lines and indentation are ignored, and a byte may be written as 4d, 0x4d, 4dh or 4d-h — so read-hex output can be edited and written back verbatim. Use this (not `write`) for any non-text file.',
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
              const offset = Math.max(0, Math.floor(input.offset ?? 0))
              const bytes = yield* Effect.try({
                try: () => parseHexInput(input.data),
                catch: (error) => new ToolFailure({ message: error instanceof Error ? error.message : String(error) }),
              })
              if (bytes.length === 0) return yield* new ToolFailure({ message: "No bytes to write — `data` parsed empty" })
              const target = yield* mutation.resolve({ path: input.filename })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external, "write"),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              // A byte patch is a surgical in-place change -> `edit` (allowed in surgical mode);
              // creating a brand-new file asserts `create` (the 1I split).
              const exists = yield* Effect.tryPromise(() =>
                import("node:fs/promises").then((fs) =>
                  fs.stat(target.canonical).then(
                    () => true,
                    () => false,
                  ),
                ),
              )
              yield* permission.assert({
                action: exists ? "edit" : "create",
                resources: [target.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const result = yield* Effect.tryPromise(() => writePatch(target.canonical, offset, bytes))
              return { bytesWritten: result.bytesWritten, offset, size: result.size, created: result.created }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({
                  message: `Unable to write-hex ${input.filename}: ${error instanceof Error ? error.message : String(error)}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/write-hex",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node],
})
