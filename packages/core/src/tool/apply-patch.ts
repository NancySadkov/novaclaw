export * as ApplyPatchTool from "./apply-patch"

import { ToolFailure } from "@novaclaw/llm"
import { FileDiff } from "@novaclaw/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { Patch } from "../patch"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "apply_patch"

/**
 * The envelope, stated wherever a model can still act on it: the schema, the tool description, and
 * the parse error. A small model that guesses this format wrong cannot recover from a bare
 * "verification failed" — it rewords the same bad body, which is a loop the streak detector then has
 * to catch (see `doom-loop.ts`'s `patchTarget`). Naming the format at the point of failure, plus an
 * explicit cheaper route for the common case, is the horizon the Juvenile Harness exists to supply.
 *
 * Ported from NancySadkov/novaclaw#6 by @DassaultFalconKing.
 */
const PATCH_FORMAT_HELP =
  'Required format: start with "*** Begin Patch", use hunks such as "*** Add File: path" followed by ' +
  '"+" content lines, and end with "*** End Patch". For a small NEW file, use the `write` tool instead.'

export const Input = Schema.Struct({
  patchText: Schema.String.annotate({
    description: `The full patch text describing add, update, and delete operations. ${PATCH_FORMAT_HELP}`,
  }),
})

export const Applied = Schema.Struct({
  type: Schema.Literals(["add", "update", "delete"]),
  resource: Schema.String,
  target: Schema.String,
})

export const Output = Schema.Struct({
  applied: Schema.Array(Applied),
  files: Schema.Array(FileDiff.Info),
})
export type Output = typeof Output.Type

export const toModelOutput = (output: Output) =>
  [
    "Applied patch sequentially:",
    ...output.applied.map(
      (item) => `${item.type === "add" ? "A" : item.type === "delete" ? "D" : "M"} ${item.resource}`,
    ),
  ].join("\n")

type Prepared =
  | (Extract<Patch.Hunk, { readonly type: "add" | "delete" }> & {
      readonly target: LocationMutation.Target
      readonly before: string
      readonly after: string
    })
  | (Extract<Patch.Hunk, { readonly type: "update" }> & {
      readonly target: LocationMutation.Target
      readonly source: Uint8Array
      readonly content: string
      readonly before: string
      readonly after: string
    })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        // ⚠️ THE ONE REAL REMAP in the tree, and the only reason `withPermission` exists: registered
        // as `apply_patch`, it answers to the `edit` action — the same action its own
        // `permission.assert({ action: "edit" })` below spends. Without the wrap the two seams
        // would disagree: a `deny edit/*` rule would still refuse every patch at execution while
        // `whollyDisabled` went on advertising the tool, i.e. a horizon the model cannot act on.
        // Elsewhere the wrap is a no-op — `Tool.permission` falls back to the registered name —
        // which is why nothing else in `src/tool/` carries one, and
        // `test/tool-permission-identity.test.ts` ledgers this site and fails if a no-op reappears.
        [name]: Tool.withPermission(
          Tool.make({
            sideEffect: "idempotent-write",
            description: `Apply one patch containing add, update, and delete file operations. ${PATCH_FORMAT_HELP} All targets are resolved and approved before target contents are read. Operations apply sequentially; if a later operation fails, earlier operations remain applied and the failure reports them explicitly. Moves and atomic rollback are not supported yet.`,
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
            execute: (input, context) => {
              const applied: Array<typeof Applied.Type> = []
              const fail = (path: string) => {
                const prefix =
                  applied.length === 0
                    ? `Unable to apply patch at ${path}`
                    : `Patch partially applied before failing at ${path}. Applied: ${applied.map((item) => item.resource).join(", ")}`
                return new ToolFailure({ message: prefix })
              }
              return Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                if (!input.patchText.trim()) return yield* new ToolFailure({ message: "patchText is required" })
                const hunks = yield* Effect.try({
                  try: () => Patch.parse(input.patchText),
                  catch: (cause) =>
                    new ToolFailure({
                      message: `apply_patch verification failed: ${String(cause)}. ${PATCH_FORMAT_HELP} Do not retry the same malformed patch.`,
                    }),
                })
                if (hunks.length === 0) return yield* new ToolFailure({ message: "patch rejected: empty patch" })
                const move = hunks.find((hunk) => hunk.type === "update" && hunk.movePath !== undefined)
                if (move) return yield* new ToolFailure({ message: "apply_patch moves are not supported yet" })

                const targets: Array<{ readonly hunk: Patch.Hunk; readonly target: LocationMutation.Target }> = []
                for (const hunk of hunks)
                  targets.push({ hunk, target: yield* mutation.resolve({ path: hunk.path, kind: "file" }) })
                const externalDirectories = new Map<string, LocationMutation.ExternalDirectoryAuthorization[]>()
                for (const { target } of targets) {
                  const external = target.externalDirectory
                  if (external) {
                    const group = externalDirectories.get(external.directory) ?? []
                    group.push(external)
                    externalDirectories.set(external.directory, group)
                  }
                }
                for (const external of externalDirectories.values()) {
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermissions(external, "write"),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                }
                yield* permission.assert({
                  action: "edit",
                  resources: [...new Set(targets.map(({ target }) => target.resource))],
                  // Deduped as PAIRS, on the canonical path. Deduping `resource` and `canonical`
                  // into two separate arrays — as the upstream PR did — lets the two disagree in
                  // length whenever a patch names one file twice under different spellings, and the
                  // index that recovered the resource then silently pointed at the wrong entry or
                  // at nothing. Every target is supplied BEFORE any file is read or written.
                  targets: [
                    ...new Map(
                      targets.map(({ target }) => [
                        target.canonical,
                        { resource: target.resource, canonical: target.canonical },
                      ]),
                    ).values(),
                  ],
                  attachmentPaths: [...(context.attachmentPaths ?? [])],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })

                const prepared: Prepared[] = []
                for (const { hunk, target } of targets) {
                  yield* Effect.gen(function* () {
                    if (hunk.type === "add") {
                      prepared.push({
                        ...hunk,
                        target,
                        before: "",
                        after:
                          hunk.contents.endsWith("\n") || hunk.contents === "" ? hunk.contents : `${hunk.contents}\n`,
                      })
                      return
                    }
                    if ((yield* fs.stat(target.canonical)).type !== "File") yield* fail(hunk.path)
                    const source = yield* fs.readFile(target.canonical)
                    const original = new TextDecoder("utf-8", { ignoreBOM: true }).decode(source)
                    const before = original.replace(/^\uFEFF/, "")
                    if (hunk.type === "delete") {
                      prepared.push({ ...hunk, target, before, after: "" })
                      return
                    }
                    const update = Patch.derive(hunk.path, hunk.chunks, original)
                    prepared.push({
                      ...hunk,
                      target,
                      source,
                      content: Patch.joinBom(update.content, update.bom),
                      before,
                      after: update.content,
                    })
                  }).pipe(Effect.mapError(() => fail(hunk.path)))
                }

                const patchFiles = prepared.map(patchFile)
                yield* Effect.forEach(
                  prepared,
                  (change) =>
                    Effect.gen(function* () {
                      if (change.type === "add") {
                        const result = yield* files.create({
                          target: change.target,
                          content:
                            change.contents.endsWith("\n") || change.contents === ""
                              ? change.contents
                              : `${change.contents}\n`,
                        })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        return
                      }
                      if (change.type === "delete") {
                        const result = yield* files.remove({ target: change.target })
                        applied.push({ type: change.type, resource: result.resource, target: result.target })
                        return
                      }
                      const result = yield* files.writeIfUnchanged({
                        target: change.target,
                        expected: change.source,
                        content: change.content,
                      })
                      applied.push({ type: change.type, resource: result.resource, target: result.target })
                    }).pipe(Effect.mapError(() => fail(change.path))),
                  { discard: true },
                )
                return { applied, files: patchFiles }
              }).pipe(
                Effect.mapError((error) => {
                  if (error instanceof ToolFailure) return error
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return fail("patch")
                }),
              )
            },
          }),
          "edit",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/apply-patch",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node],
})

function patchFile(change: Prepared): typeof FileDiff.Info.Type {
  const counts = diffLines(change.before, change.after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return {
    file: change.target.resource,
    patch: createTwoFilesPatch(change.target.resource, change.target.resource, change.before, change.after),
    status: change.type === "add" ? "added" : change.type === "delete" ? "deleted" : "modified",
    ...counts,
  }
}
