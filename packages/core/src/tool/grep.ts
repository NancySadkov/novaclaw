export * as GrepTool from "./grep"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import path from "path"
import { makeLocationNode } from "../effect/app-node"
import { FileSystem } from "../filesystem"
import { FSUtil } from "../fs-util"
import { Location } from "../location"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { ProjectExclusion } from "../project-exclusion"
import { Ripgrep } from "../ripgrep"
import { RelativePath } from "../schema"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "grep"

export const Input = Schema.Struct({
  pattern: FileSystem.GrepInput.fields.pattern.annotate({
    description: "Regex pattern to search for in file contents",
  }),
  path: RelativePath.pipe(Schema.optional).annotate({
    description: "Relative directory to search. Defaults to the active Location.",
  }),
  include: FileSystem.GrepInput.fields.include.annotate({
    description: 'File glob to include in the search (for example, "*.js" or "*.{ts,tsx}")',
  }),
  limit: FileSystem.GrepInput.fields.limit.annotate({
    description: "Maximum matches to return",
  }),
})

/**
 * 🔴 A STRUCT, for the reason spelled out on `glob`'s `Output`: an array of survivors is a false
 * statement about what the tool did, and ruling 2 puts that fault in the DATA rather than in how the
 * data happens to be rendered.
 *
 * ⚠️ The falsehood is louder here than in `glob`, because this output leads with `Found N matches`.
 * A count derived from a screened list reads as the total, so the model was handed a confident
 * number that was not the answer to the question it asked — the shape of a fault described falsely,
 * not merely a fact omitted.
 */
export const Output = Schema.Struct({
  matches: Schema.Array(FileSystem.Match),
  /** How many matches a project exclusion removed. Absent when no exclusion governs the search root. */
  withheld: Schema.optional(Schema.Number),
  /** Absolute path of the `novaclaw.json` that declared the list, so the notice can name it. */
  excludedBy: Schema.optional(Schema.String),
})
type ModelOutput = typeof Output.Encoded

/** Format raw search matches into the familiar concise model output. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.matches.length === 0 ? ["No files found"] : [`Found ${output.matches.length} matches`]
  let current = ""
  for (const match of output.matches) {
    if (current !== match.entry.path) {
      if (current) lines.push("")
      current = match.entry.path
      lines.push(`${match.entry.path}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text}`)
  }
  const notice = ProjectExclusion.withheldNotice(output.withheld ?? 0, output.excludedBy)
  if (notice) lines.push("", notice)
  return lines.join("\n")
}

/** Grep leaf that defaults its filesystem root to the active Location. */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    const location = yield* Location.Service
    const permission = yield* PermissionV2.Service
    const mutation = yield* LocationMutation.Service

    yield* tools
      .register({
        // ⚠️ A REMAP — the same one `glob.ts` carries, and for the same reason: registered as `grep`,
        // it answers to the `explore` action, which is what its own `permission.assert` below spends.
        // Searching and listing are ONE grant class, so one user rule has to reach both tools; before
        // the wrap, `explore: "deny"` refused every search while leaving both ADVERTISED, and
        // `grep: "deny"` withdrew grep while glob went on working. See `glob.ts` for the full note and
        // `test/tool-permission-identity.test.ts` for the ledger entry.
        [name]: Tool.withPermission(
          Tool.make({
            sideEffect: "read",
            outputPreview: "earliest",
            description:
              "Search file contents by regular expression within the active Location or an absolute managed tool-output file. Use a path to narrow the search, include to filter files by glob, and limit to bound the match count. Returns concise file resources, line numbers, and bounded line previews.",
            input: Input,
            output: Output,
            toModelOutput: ({ output }) => [
              {
                type: "text",
                text: toModelOutput({
                  ...output,
                  matches: output.matches.map((match) => ({
                    ...match,
                    entry: { ...match.entry, path: path.resolve(location.directory, match.entry.path) },
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
                // Classify the search root BEFORE searching it — see the same guard in glob.ts. grep
                // matters more than glob here because it returns matching LINES, i.e. real file CONTENT
                // from outside the Location, not just names. `input.path` is typed RelativePath but that
                // brand does not validate, so an absolute path was previously searched silently.
                const resolved = yield* mutation.resolve({ path: input.path ?? ".", kind: "directory" })
                const external = resolved.externalDirectory
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
                    root: ".",
                    path: input.path,
                    include: input.include,
                    limit: input.limit,
                  },
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source,
                })
                const target = resolved.canonical
                const info = yield* fs.stat(target).pipe(Effect.catch(() => Effect.succeed(undefined)))
                const searchRoot = info?.type === "Directory" ? target : path.dirname(target)
                // The SECOND exclusion seam — see the same block in `glob.ts`. It matters MORE
                // here: grep returns matching LINES, so an unfiltered row is the excluded file's
                // actual content arriving in the model's context.
                const exclusions = yield* mutation.exclusionsFor(searchRoot)
                return yield* ripgrep
                  .grep({
                    cwd: info?.type === "Directory" ? target : path.dirname(target),
                    pattern: input.pattern,
                    file: info?.type === "File" ? path.basename(target) : undefined,
                    include: input.include,
                    limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                  })
                  .pipe(
                    Effect.map((result) => {
                      const screened = ProjectExclusion.screenAll(exclusions, result, (match) =>
                        path.resolve(searchRoot, match.entry.path),
                      )
                      return {
                        matches: screened.kept.map((match) =>
                          FileSystem.Match.make({
                            ...match,
                            entry: FileSystem.Entry.make({
                              ...match.entry,
                              path: RelativePath.make(
                                path.relative(location.directory, path.resolve(searchRoot, match.entry.path)),
                              ),
                            }),
                          }),
                        ),
                        withheld: screened.withheld,
                        excludedBy: exclusions?.file,
                      }
                    }),
                  )
              }).pipe(
                Effect.mapError((error) => {
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return new ToolFailure({ message: `Unable to grep for ${input.pattern}` })
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
  name: "tool/grep",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FSUtil.node, Ripgrep.node, Location.node, PermissionV2.node],
})
