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

/**
 * What rides alongside an image in the tool result.
 *
 * Exported so tests can assert its PROPERTIES without keeping a second copy of the sentence —
 * a duplicated string is a pin that fails on every wording change and proves nothing about
 * behaviour. `test/tool-read.test.ts` checks that it still confirms the read AND still asks for
 * the description; `notes/reports/vision-on-disk-2026-08-19.md` is why the ask exists.
 */
/**
 * What `read` advertises to a model that CAN see, and to one that cannot.
 *
 * 🔴 **A text-only model used to be told a picture "arrives as a picture you can see"** (owner,
 * 2026-08-20: *"please ensure the text only models are spared of vision model related stuff"*). The
 * wasted tokens were the smaller half: the model believed the promise, called `read` on a PNG, and
 * the capability gate in `to-llm-message` then replaced the bytes with "this model cannot read
 * images" — the product describing its own behaviour falsely, which is the exact fault ruling 2
 * forbids and which `perceptionSection` (correctly gated on the same modality) exists to prevent.
 *
 * ⚠️ Self-inflicted by the fix that made vision WORK. The image clause was deliberately made
 * unhedged and moved to the FRONT on 2026-08-19, because a hedge reads as a prohibition and
 * Holo-3.1 was refusing to open images at all. That was right for a vision model and made the
 * text-only case worse in the same commit — so the clause is now conditional rather than softened,
 * and the vision wording is untouched.
 */
/** Everything true of `read` on any model. Written out rather than assembled — one string per
 *  audience is longer and is what a reader can actually check against what the model receives. */
const SHARED_TAIL =
  "Prefer this over bash cat/head/tail. Continue paged reads with `offset` until complete; never conclude from a partial view. A complete lossless text read returns the observation token `write` needs to replace that existing file; pages accumulate only while its version is unchanged. Binary files give a `read-hex` hint. Relative paths use the current location; absolute paths may read anywhere the host account permits. An observation proves freshness, not write permission."

/** Advertised to a model whose catalog declares an `image` input modality. UNCHANGED wording. */
/**
 * Does this error mean "there is no such file"?
 *
 * Effect's filesystem raises a `PlatformError` carrying `reason: "NotFound"` (the shape `bash.ts`
 * catches with `Effect.catchReason("PlatformError", "NotFound", …)`). The raw `ENOENT` check is a
 * second net for anything that reaches here without having been wrapped — a missing file is common
 * enough, and the consequence of misreporting it bad enough, that one predicate covering both beats
 * a tidy one covering the case we happen to have seen.
 */
/**
 * Turn a filesystem failure into a sentence that says what happened AND what to do next.
 *
 * 🔴 Owner ruling 2026-08-20. Every one of these used to render as `Unable to read <path>`, which is
 * true of a hallucinated name, a permission problem and a locked file alike — three causes with three
 * different next actions. Measured the same day: the model invented `icon_400_r20_c17.png`, read the
 * undifferentiated message as "this file is broken", and guessed four more names.
 *
 * ⚠️ The UNKNOWN case must stay honest. It is where every errno we did not anticipate lands, and
 * dressing it in the wording of a cause we merely suspect is how a wrong steer becomes confident. It
 * says it does not know and offers both checks.
 */
export const readFailureMessage = (error: unknown, path: string): string => {
  const reason = String((error as { readonly reason?: unknown } | undefined)?.reason ?? "")
  const code = String((error as { readonly code?: unknown } | undefined)?.code ?? "")
  const text = String((error as { readonly message?: unknown } | undefined)?.message ?? "")
  const matches = (pattern: RegExp, ...literals: readonly string[]) =>
    literals.includes(reason) || literals.includes(code) || pattern.test(text)

  // Missing — the only cause the model itself can have created, so it gets the explicit "do not
  // guess" that the perception section also carries.
  if (matches(/\bENOENT\b|\bNotFound\b/, "NotFound", "ENOENT"))
    return (
      `${path} does not exist. If you have not listed this folder yet, list it (\`glob\` or ` +
      `\`bash ls\`) and read one of the names it returns — do not guess or invent a filename.`
    )

  // Refused — the path is real; the process may not open it.
  if (matches(/\bEACCES\b|\bEPERM\b|permission denied/i, "PermissionDenied", "EACCES", "EPERM"))
    return (
      `${path} exists but could not be opened: permission denied. Check whether this session is ` +
      `allowed to read that location before trying again — re-reading it will fail the same way.`
    )

  // Held — real, permitted, and busy. Retrying can genuinely work here, which is why it is the one
  // case that says so.
  if (matches(/\bEBUSY\b|\bETXTBSY\b|being used by another process/i, "Busy", "EBUSY", "ETXTBSY"))
    return `${path} is locked by another process. Wait a moment and read it again, or continue with another file.`

  // A path whose PARENT is not a folder — `a/b.txt/c.txt`, which is what a model produces when it
  // appends to a filename it already had. The correction is specific and the model can act on it
  // alone, so it does not belong in the unknown bucket: `LocationMutation` raises this reason before
  // the filesystem is ever touched, which is why it arrives with no errno attached.
  if (matches(/\bENOTDIR\b/, "non_directory_ancestor", "ENOTDIR"))
    return (
      `${path} cannot exist: something on the way to it is a file, not a folder. List the folder you ` +
      `meant (\`glob\` or \`bash ls\`) and read a name it returns.`
    )

  // A directory handed to a file read — a mistake with an obvious correction.
  if (matches(/\bEISDIR\b/, "EISDIR")) return `${path} is a directory, not a file. List it instead to see what it holds.`

  return (
    `Unable to read ${path}${text ? ` (${text})` : ""}. The cause is not one this tool recognises: ` +
    `check that the path exists by listing its folder, and that this session may read that location.`
  )
}

export const DESCRIPTION =
  "Read a file, LOOK AT an image, page through large UTF-8 text, or list a directory. An image (png/jpeg/gif/webp) arrives as a picture you can see — use it for what a file LOOKS like. " +
  SHARED_TAIL

/** Advertised to a model that declares no image modality: the same tool, minus a promise it cannot
 *  keep. `read` still opens the file; it simply does not claim the bytes come back as a picture. */
export const DESCRIPTION_TEXT_ONLY = "Read a file, page through large UTF-8 text, or list a directory. " + SHARED_TAIL

/**
 * What `read` returns INSTEAD of an image the current request cannot carry.
 *
 * States the fact, the cause, and the one action that resolves it — and asks for the descriptions
 * FIRST, because that is the whole point: what the model says now is what survives when the older
 * pictures are elided to make room for this one.
 */
export const heldImageNotice = (path: string, limit: number): string =>
  `[Not opened: ${path}. This model accepts only ${limit} image${limit === 1 ? "" : "s"} per request, and you are already holding ${limit} that you have not described yet. Opening another would push one of them out of this conversation, and it would be gone. FIRST write down what each image you are holding shows — one line each is enough — then read this file again; the pictures you have described survive as your own text even after the pixels go.]`

export const IMAGE_NOTE =
  "Image read successfully. Write one line now saying what it shows, before you read anything else — " +
  "images are dropped from context once this model's per-request limit is reached, and only what you " +
  "wrote down survives. If you are working through several images, describe each as you open it."
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
            DESCRIPTION,
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
              // 🔴 **"Image read successfully" was the whole message, and it cost five wrong
              // filenames.** Measured 2026-08-19 on the six-glyph corpus: the model read six images
              // in a row, said nothing about any of them, and — once the per-request image budget
              // elided the oldest — named all six from memory it did not have, getting five wrong
              // (`notes/reports/vision-on-disk-2026-08-19.md`).
              //
              // The ask sits HERE rather than in the system prompt because this is the moment it is
              // actionable: the pixels are in front of the model right now, and this is the last
              // instant at which a description is free. It also states the CONSEQUENCE rather than
              // giving a bare instruction — jh §13.4's finding is that the model never instruments
              // voluntarily, and AGENTS.md's own note on `PROJECT_SCOPE_INSTRUCTION` is that the
              // vague form is the one a model reasons its way around.
              //
              // ⚠️ Honest about what this is: an INFORMATIONAL lever, and the pitfall this repo
              // keeps re-learning is that informational levers engage while mechanical ones convert.
              // The mechanical fix — an image is not ELIDABLE until its description is in the
              // transcript — is not built. This is measured against that failure, not
              // assumed to fix it.
              { type: "text", text: IMAGE_NOTE },
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
                // 🔴 **THE MECHANICAL HALF.** Within one assistant turn there is no text between
                // tool calls, so an image opened after the endpoint's cap is reached cannot have
                // been described — and `budgetImages` will elide something to make room. Measured
                // 2026-08-20 on the six-glyph corpus: the model read all six, three were evicted,
                // and it did not report a gap — it invented a crown, a shield and a helmet that do
                // not exist. Three informational levers were tried first and none converted.
                //
                // So the pixels are WITHHELD rather than handed over and then silently dropped. The
                // model receives a sentence instead, which ends the turn and makes it speak; what it
                // says about the images it already holds is what survives eviction as text. Then it
                // reads this file again with the budget reset.
                //
                // ⚠️ A refusal, not a failure: the tool SUCCEEDS with text, so the drain continues and
                // nothing in the transcript reads as an error the user has to care about.
                const budget = context.imageBudget
                if (budget !== undefined && budget.held >= budget.limit)
                  // The same shape a TEXT read returns, so the notice reaches the model the way every
                  // other text does — through `structured` — instead of inventing a result kind that
                  // `toModelOutput` would then have to learn about.
                  return {
                    uri: resource,
                    name: input.path,
                    content: heldImageNotice(input.path, budget.limit),
                    encoding: "utf8" as const,
                    mime: "text/plain",
                  }
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
                    : // Missing / refused / locked / a directory each get their own next action —
                      // see `readFailureMessage`, and `perceptionSection` for the "never invent a
                      // filename" rule the missing case restates.
                      readFailureMessage(error, input.path)
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
