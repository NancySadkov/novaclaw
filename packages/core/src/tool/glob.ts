export * as GlobTool from "./glob"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { PermissionV2 } from "../permission"
import { ProjectExclusion } from "../project-exclusion"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "glob"

export const Input = Schema.Struct({
  pattern: FileSystem.GlobInput.fields.pattern.annotate({ description: "Glob pattern to match files against" }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  limit: FileSystem.GlobInput.fields.limit.annotate({
    description: "Maximum results to return",
  }),
})

/**
 * 🔴 A STRUCT, not the bare array it was until 2026-09-04, because **an array of survivors is a
 * false statement about what this tool did.**
 *
 * A project exclusion removes rows from this result. `ProjectExclusion.screenAll` has always
 * returned the count of what it removed, and both call sites — here and in `grep` — took `.kept` and
 * threw the number away. So the model asked for every file, got a shorter list, and had no way to
 * know a list existed. That is the exact shape `project-exclusion.ts`'s own refusal comment warns
 * about for the single-file path — *"a silent 'no such file' is the shape that makes an agent retry
 * the same path five different ways and then conclude the repository is broken"* — and the
 * enumeration seam was doing it silently while the refusal seam explained itself carefully.
 *
 * **Why the fix is the SCHEMA and not the formatter**, which is the tie and is answered by the
 * vision, not by convenience:
 *
 * · *A fault is never described falsely* (ruling 2). `Entry[]` can only say "these are the matches",
 *   and that sentence is untrue once rows were screened out. The untruth is in the DATA, so a
 *   truthful rendering laid over an untruthful structure fixes exactly one reader — whichever one
 *   happens to call `toModelOutput` — and leaves every other reader holding the same false claim.
 * · *Architecture quality outranks legacy compatibility* (principle 1). `Schema.Array(Entry)` is the
 *   shape from before exclusions existed. Keeping it and carrying the truth beside it in a rendered
 *   string is precisely "wrapping new logic in an old abstraction"; screening is part of what the
 *   operation DID, so it belongs in the record of what the operation did.
 * · **Storage is the direction that decides it.** This output is persisted on the message part and
 *   read back later — by compaction, by a re-render, by whatever consumer comes next. A count that
 *   lives only in a formatted string is gone by then, and the stored row goes on asserting a
 *   complete result forever. A field is lost in three directions, and storage is the one nobody
 *   notices.
 *
 * ⚠️ The mechanical fact — `toModelOutput` receives `{ input, output }` and nothing else, so a
 * number the tool computes but does not RETURN is unreachable — is how the old shape's inadequacy
 * was DISCOVERED, not why it was changed. Had the formatter been handed more, the array would still
 * have been the wrong record.
 */
export const Output = Schema.Struct({
  entries: Schema.Array(FileSystem.Entry),
  /** How many rows a project exclusion removed. Absent when no exclusion governs the search root. */
  withheld: Schema.optional(Schema.Number),
  /** Absolute path of the `novaclaw.json` that declared the list, so the notice can name it. */
  excludedBy: Schema.optional(Schema.String),
})
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.entries.length === 0 ? ["No files found"] : output.entries.map((item) => item.path)
  const notice = ProjectExclusion.withheldNotice(output.withheld ?? 0, output.excludedBy)
  return (notice ? [...lines, "", notice] : lines).join("\n")
}

/** Glob leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        // ⚠️ A REMAP, and the reason `withPermission` exists (see `tool.ts`): registered as `glob`, it
        // answers to the `explore` action — the SAME action its own `permission.assert` below spends.
        // glob and grep are one grant class ("listing/searching"), so one user rule must govern both.
        //
        // Without the wrap the two seams disagreed, in both directions at once. `permission.assert`
        // spent `explore` while `ToolRegistry.materialize`'s `whollyDisabled` resolved the REGISTERED
        // name, so `explore: "deny"` refused every search while both tools stayed ADVERTISED — a
        // horizon the model can see but cannot act on, which is exactly what `apply_patch` → `edit`
        // exists to prevent — and `glob: "deny"` withdrew glob while leaving grep fully working.
        //
        // Ledgered in `test/tool-permission-identity.test.ts`. The end-to-end property (one rule
        // withdraws BOTH tools; a rule naming either registered name withdraws neither) is pinned by
        // `test/tool-search-containment.test.ts`, and the consequence for the `explore` subagent — it
        // now needs ONE grant where it needed three — by `test/permission-baseline.test.ts`.
        [name]: Tool.withPermission(
          Tool.make({
            sideEffect: "read",
            outputPreview: "earliest",
            description:
              "Find files by glob pattern within the active Location. Returns concise relative file resources. Use a relative path to narrow the search and limit to bound the result count.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: toModelOutput({
                  ...output,
                  entries: output.entries.map((entry) => ({
                    ...entry,
                    path: path.resolve(location.directory, entry.path),
                  })),
                }),
              },
            ],
            execute: (input, context) =>
              Effect.gen(function* () {
                const source = {
                  type: "tool" as const,
                  messageID: context.assistantMessageID,
                  callID: context.toolCallID,
                }
                // Classify the search root BEFORE searching it. `input.path` is typed RelativePath, but
                // that brand carries no validation, so an absolute path (or a `../..` escape) used to be
                // resolved and searched silently — the one path-taking tool pair that never classified
                // its target, while read/write/edit/apply-patch/trash/hex/bash all did. That gap also
                // slipped past the unattended confinement stance, which gates exactly this permission.
                const target = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
                const external = target.externalDirectory
                if (external)
                  yield* permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external, "read"),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source,
                  })
                // 1I: glob + grep share the "explore" action — listing/searching is one grant class.
                // The `withPermission` wrap above makes the HORIZON filter spend this same action.
                yield* permission.assert({
                  action: "explore",
                  resources: [input.pattern],
                  save: ["*"],
                  metadata: {
                    root: input.path ?? ".",
                    path: input.path,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const cwd = target.canonical
                // The SECOND exclusion seam, and the only one besides `LocationMutation.resolve`.
                // `resolve` above spoke for the search ROOT; it cannot speak for rows this tool
                // never named. Without this, `exclude: ["secrets"]` would still list every path
                // under `secrets/` — a directory listing IS a read of what the folder contains, and
                // it is the cheapest way to learn what a user was trying to hide.
                const exclusions = yield* mutation.exclusionsFor(cwd)
                return yield* ripgrep
                  .glob({
                    cwd,
                    pattern: input.pattern,
                    limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                  })
                  .pipe(
                    Effect.map((result) => {
                      const screened = ProjectExclusion.screenAll(exclusions, result, (entry) =>
                        path.resolve(cwd, entry.path),
                      )
                      return {
                        entries: screened.kept.map((entry) =>
                          FileSystem.Entry.make({
                            ...entry,
                            path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                          }),
                        ),
                        // `withheld` is 0 when no exclusion governs the root, and `screenAll` returns
                        // the rows untouched in that case — so the notice never fires on a project
                        // that excludes nothing.
                        withheld: screened.withheld,
                        excludedBy: exclusions?.file,
                      }
                    }),
                  )
              }).pipe(
                Effect.mapError((error) => {
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({ message: `Unable to find files matching ${input.pattern}` })
                }),
              ),
          }),
          "explore",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/glob",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, Ripgrep.node, Location.node, PermissionV2.node],
})
