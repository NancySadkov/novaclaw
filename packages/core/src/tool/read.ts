export * as ReadTool from "./read"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { binaryNote } from "./hex"
import { ReadGuidance } from "./read-guidance"
import { ReadToolFileSystem } from "./read-filesystem"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "read"
const SUPPORTED_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"])
const LocationInput = Schema.Struct({
  path: Schema.String,
  offset: ReadToolFileSystem.PageInput.fields.offset.annotate({
    description: "The 1-based directory entry or text line offset to start reading from",
  }),
  limit: ReadToolFileSystem.PageInput.fields.limit.annotate({
    description: "The maximum number of directory entries or text lines to read",
  }),
})
const Input = LocationInput
const Output = Schema.Union([FileSystem.Content, ReadToolFileSystem.TextPage, ReadToolFileSystem.ListPage])

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          sideEffect: "read",
          description:
            "Read a text file or supported image, page through a large UTF-8 text file by line offset, or list a directory page. Prefer this over `bash` cat/head/tail — it pages safely and warns on large slices. A large file comes back in chunks (~1500 lines / 24 KB per read): continue with `offset`, and never review or conclude from a partial view — read the rest first. Binary files are refused with a format hint: use `read-hex` for those. Relative paths resolve from the current location; absolute paths may point anywhere the host account can read. Reading never grants permission to modify that path.",
          input: Input,
          output: Output,
          // ── Deliberately NOT untrusted-framed, and this is the reasoning ────────────────────────
          //
          // `webfetch`, `websearch` and the MCP adapter prefix their model-facing output with
          // `SessionOrigin.externalContentFrame` (2026-07-30) because each of them GOES AND GETS
          // bytes from a party other than the user. `read` does not: it opens a path on the user's
          // own machine, inside a location the permission evaluator already gated, at a path the
          // model itself named — which is also the last thing in the transcript before this result.
          // The frame would therefore carry no fact the turn does not already hold, while costing
          // tokens on the single hottest tool in the tree, every read, for the whole run.
          //
          // Under-framing is a security gap and over-framing is context bloat, so state the residual
          // honestly rather than pretending it away: a file's CONTENTS can of course be hostile —
          // an agent may have written a fetched page to disk, or the repo may simply contain one.
          // What that argues for is framing at the moment the bytes ENTER the machine (which is what
          // the three tools above now do) rather than declaring the user's whole filesystem
          // untrusted at every read, which would be both unaffordable and, for most files, false.
          // `test/untrusted-framing.test.ts` records this file in the ledger as a decision, so a
          // future reader finds a ruling here instead of an omission.
          //
          // ⚠️ Note also what this projection actually does: for text it returns `[]`, and
          // `Tool.make`'s settlement then serves the ENCODED OUTPUT as structured JSON — the file's
          // text reaches the model through `structured`, never through a `content` text part. Only
          // images take the branch below. A future framing attempt aimed at this function alone
          // would not touch the text path at all.
          toModelOutput: ({ input, output }) => {
            if (!("encoding" in output) || output.encoding !== "base64" || !SUPPORTED_IMAGE_MIMES.has(output.mime))
              return []
            return [
              { type: "text", text: "Image read successfully" },
              { type: "file", data: output.content, mime: output.mime, name: input.path },
            ]
          },
          execute: (input, context) => {
            return Effect.gen(function* () {
              const source = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              const target = yield* mutation.resolve({ path: input.path, kind: "directory" })
              const external = target.externalDirectory
              if (external)
                yield* permission.assert({
                  ...LocationMutation.externalDirectoryPermission(external, "read"),
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
              const resource = target.resource
              const absolute = AbsolutePath.make(target.canonical)
              const type = yield* reader.inspect(absolute)
              yield* permission.assert({
                action: name,
                resources: [resource],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source,
              })
              if (type === "directory")
                return yield* reader.list(absolute, { offset: input.offset, limit: input.limit })
              const content = yield* reader.read(absolute, resource, {
                offset: input.offset,
                limit: input.limit,
              })
              if ("encoding" in content && content.encoding === "base64" && SUPPORTED_IMAGE_MIMES.has(content.mime)) {
                return yield* image
                  .normalize(resource, { ...content, encoding: "base64" })
                  .pipe(Effect.catchTag("Image.ResizerUnavailableError", () => Effect.succeed(content)))
              }
              if ("encoding" in content && content.encoding === "base64")
                return yield* Effect.fail(
                  new ReadToolFileSystem.BinaryFileError({
                    resource,
                    note: binaryNote(resource, Math.floor((content.content.length * 3) / 4), undefined),
                  }),
                )
              // 1F: warn the model when a read takes a large slice of context so small
              // models continue in chunks (offset/limit) rather than holding a whole file.
              if (content instanceof ReadToolFileSystem.TextPage) {
                const note = ReadGuidance.forText({
                  text: content.content,
                  truncated: content.truncated,
                  offset: content.offset,
                  ...(content.next === undefined ? {} : { next: content.next }),
                })
                return note
                  ? new ReadToolFileSystem.TextPage({ ...content, content: `${content.content}\n\n[read] ${note}` })
                  : content
              }
              if (content.encoding === "utf8") {
                const note = ReadGuidance.forText({ text: content.content, truncated: false, offset: 1 })
                return note ? { ...content, content: `${content.content}\n\n[read] ${note}` } : content
              }
              return content
            }).pipe(
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                const message =
                  error instanceof ReadToolFileSystem.BinaryFileError ||
                  error instanceof ReadToolFileSystem.MediaIngestLimitError ||
                  error instanceof Image.DecodeError ||
                  error instanceof Image.SizeError
                    ? error.message
                    : `Unable to read ${input.path}`
                return new ToolFailure({ message })
              }),
            )
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/read",
  layer,
  deps: [ToolRegistry.node, ReadToolFileSystem.node, LocationMutation.node, Image.node, PermissionV2.node],
})
