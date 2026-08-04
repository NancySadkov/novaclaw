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

export const Output = Schema.Array(FileSystem.Entry)
type ModelOutput = typeof Output.Encoded

/** Format raw search results into the concise line-oriented output models expect. */
export const toModelOutput = (output: ModelOutput) => {
  const lines = output.length === 0 ? ["No files found"] : output.map((item) => item.path)
  return lines.join("\n")
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
                text: toModelOutput(
                  output.map((entry) => ({ ...entry, path: path.resolve(location.directory, entry.path) })),
                ),
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
                return yield* ripgrep
                  .glob({
                    cwd,
                    pattern: input.pattern,
                    limit: input.limit ?? Number.MAX_SAFE_INTEGER,
                  })
                  .pipe(
                    Effect.map((result) =>
                      result.map((entry) =>
                        FileSystem.Entry.make({
                          ...entry,
                          path: RelativePath.make(path.relative(location.directory, path.resolve(cwd, entry.path))),
                        }),
                      ),
                    ),
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
