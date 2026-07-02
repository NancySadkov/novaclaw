/**
 * 1L: hex inspection for binary files — the read tool's companion that never "freaks out"
 * on a `.bin`/`.iso`/`.o`. Reads a byte window at an offset and prints the ROUND-TRIPPABLE
 * dump (read output is valid write-hex input), paged like the large-read guard so it works
 * on multi-GB images. Pure TS — no dependency on a platform `hexdump`.
 */
export * as ReadHexTool from "./read-hex"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { detectFileType, hexDump } from "./hex"
import { DEFAULT_HEX_BYTES, MAX_HEX_BYTES, readWindow } from "./hex-io"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read-hex"

export const Input = Schema.Struct({
  filename: Schema.String.annotate({
    description: "File to inspect. Relative paths resolve within the active Location.",
  }),
  offset: Schema.Number.annotate({
    description: "Byte offset to start reading from (default 0).",
  }).pipe(Schema.optional),
  length: Schema.Number.annotate({
    description: `Number of bytes to read (default ${DEFAULT_HEX_BYTES}, max ${MAX_HEX_BYTES} per call — page with \`offset\` for more).`,
  }).pipe(Schema.optional),
})

export const Output = Schema.Struct({
  content: Schema.String,
  offset: Schema.Number,
  bytes: Schema.Number,
  size: Schema.Number,
  next: Schema.Number.pipe(Schema.optional),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) => {
  const head = `# ${output.bytes} bytes @${output.offset} of ${output.size} total`
  const tail = output.next === undefined ? "" : `\n# more follows — call read-hex again with offset=${output.next}`
  return `${head}\n${output.content}${tail}`
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Inspect a BINARY file as a hex dump: 16 hex bytes per line, `;` starts a comment carrying the line's offset and ascii gloss. Reads a window of `length` bytes at `offset` — it pages, so it works on multi-GB images. The output format is exactly what `write-hex` accepts, so you can edit a dump and write it back. Use this (not `read`) for .bin/.iso/.o/object files/images and any non-text file.",
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
              const length = Math.min(Math.max(1, Math.floor(input.length ?? DEFAULT_HEX_BYTES)), MAX_HEX_BYTES)
              const target = yield* mutation.resolve({ path: input.filename })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external, "read"),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              // A hex read IS a read — saved `read` grants govern it identically.
              yield* permission.assert({
                action: "read",
                resources: [target.resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              const window = yield* Effect.tryPromise(() => readWindow(target.canonical, offset, length))
              const end = offset + window.bytes.length
              const type = offset === 0 ? detectFileType(window.bytes) : undefined
              const header = type ? `; ${type.format} — ${type.description}\n` : ""
              return {
                content: header + hexDump(window.bytes, offset),
                offset,
                bytes: window.bytes.length,
                size: window.size,
                ...(end < window.size ? { next: end } : {}),
              }
            }).pipe(
              Effect.mapError((error) => {
                if (error instanceof ToolFailure) return error
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({
                  message: `Unable to read-hex ${input.filename}: ${error instanceof Error ? error.message : String(error)}`,
                })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read-hex",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, PermissionV2.node],
})
