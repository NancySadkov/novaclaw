export * as ReadTool from "./read"

/**
 * ⚠️ **`read` is ungated BECAUSE it is redacted.** It is deliberately not behind a permission ask,
 * and that trade only holds while its output is scrubbed — if the redaction is ever removed,
 * weakened, or bypassed for a caller, gate the operation in the SAME change. Carried here
 * 2026-08-12 from the closed Fast Chat program's standing constraints, whose roadmap file was
 * deleted; this is the code the constraint binds.
 */

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FileObservation } from "../file-observation"
import { Image } from "../image"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AbsolutePath } from "../schema"
import { SessionSchema } from "../session/schema"
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
const Observation = Schema.Struct({
  token: Schema.String,
  coverage: Schema.Literals(["partial", "full"]),
})
const Output = Schema.Union([
  Schema.Struct({ ...FileSystem.Content.fields, observation: Observation.pipe(Schema.optional) }),
  Schema.Struct({ ...ReadToolFileSystem.TextPage.fields, observation: Observation.pipe(Schema.optional) }),
  ReadToolFileSystem.ListPage,
])

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const reader = yield* ReadToolFileSystem.Service
    const mutation = yield* LocationMutation.Service
    const image = yield* Image.Service
    const permission = yield* PermissionV2.Service
    const observations = yield* FileObservation.Service

    yield* tools
      .register({
        [name]: Tool.make({
          sideEffect: "read",
          description:
            // ⚠️ The image clause LEADS and is unhedged, and that is the fix rather than the wording.
            // It used to open "Read text or a supported image, …", which a model reads as "opens the
            // file" — true of every binary it cannot use. Measured 2026-08-19: Holo-3.1 asked to
            // rename a folder of PNGs never called this tool once and said it could not see them
            // (`notes/reports/vision-on-disk-2026-08-19.md`). Codex fixed the same bug the same way
            // (openai/codex#23949). Say that the picture ARRIVES; a hedge reads as a prohibition.
            "Read a file, LOOK AT an image, page through large UTF-8 text, or list a directory. An image file (png, jpeg, gif, webp) is delivered to you as a picture you can actually see, so use this to answer anything about what a file LOOKS like — a photo's contents, what an icon depicts, what a screenshot shows. Prefer this over bash cat/head/tail. Continue paged reads with `offset` until complete; never conclude from a partial view. A complete lossless text read returns the observation token `write` needs to replace that existing file; pages accumulate only while its version is unchanged. Binary files give a `read-hex` hint. Relative paths use the current location; absolute paths may read anywhere the host account permits. An observation proves freshness, not write permission.",
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
              const observation = yield* observeText(observations, context.sessionID, target, content)
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
                return {
                  ...content,
                  ...(observation ? { observation } : {}),
                  ...(note ? { content: `${content.content}\n\n[read] ${note}` } : {}),
                }
              }
              if (content.encoding === "utf8") {
                const note = ReadGuidance.forText({ text: content.content, truncated: false, offset: 1 })
                return {
                  ...content,
                  ...(observation ? { observation } : {}),
                  ...(note ? { content: `${content.content}\n\n[read] ${note}` } : {}),
                }
              }
              return content
            }).pipe(
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                const message =
                  error instanceof FileObservation.ChangedDuringReadError
                    ? "File changed while it was being read. Read it again before relying on its contents."
                    : error instanceof ReadToolFileSystem.BinaryFileError ||
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
  deps: [
    ToolRegistry.node,
    ReadToolFileSystem.node,
    LocationMutation.node,
    FileObservation.node,
    Image.node,
    PermissionV2.node,
  ],
})

const observeText = Effect.fn("ReadTool.observeText")(function* (
  observations: FileObservation.Interface,
  sessionID: SessionSchema.ID,
  target: FileObservation.Target,
  content: FileSystem.Content | ReadToolFileSystem.TextPage,
) {
  if (!(content instanceof ReadToolFileSystem.TextPage) && content.encoding !== "utf8") return undefined
  const version = yield* observations.snapshot(target)
  const coverage =
    content instanceof ReadToolFileSystem.TextPage
      ? ReadToolFileSystem.pageCoverage(version.text, content)
      : version.text === content.content
        ? { start: 0, end: version.totalLength, total: version.totalLength, full: true }
        : undefined
  if (!coverage) return yield* new FileObservation.ChangedDuringReadError({ path: target.resource })
  if ("lossless" in coverage && !coverage.lossless) return undefined
  return yield* observations.record({ sessionID, target, version, coverage })
})
