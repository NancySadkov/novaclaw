/**
 * Model-facing V2 costed-edit leaf. Relative paths resolve within the active
 * Location. Absolute paths inside that Location are accepted, while explicit
 * absolute external paths retain mutation capability through a separate
 * external_directory approval before edit approval.
 */
export * as EditTool from "./edit"

import { ToolFailure } from "@novaclaw/llm"
import { FileDiff } from "@novaclaw/schema/file-diff"
import { createTwoFilesPatch, diffLines } from "diff"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FileMutation } from "../file-mutation"
import { FSUtil } from "../fs-util"
import { LocationMutation } from "../location-mutation"
import { PermissionV2 } from "../permission"
import { AUTO_APPLY_COST_CEILING, find as findMatch, replace as replaceMatches } from "./edit-match"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "edit"

export const Input = Schema.Struct({
  path: Schema.String.annotate({
    description:
      "File path to edit. Relative paths resolve within the active Location. Absolute paths inside that Location are accepted; external absolute paths require external_directory approval.",
  }),
  oldString: Schema.String.annotate({ description: "Exact text to replace" }),
  newString: Schema.String.annotate({ description: "Replacement text, which must differ from oldString" }),
  replaceAll: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "Replace all exact occurrences of oldString (default false)",
  }),
})

export const Output = Schema.Struct({
  files: Schema.Array(FileDiff.Info),
  replacements: Schema.Number,
  match: Schema.Struct({
    tier: Schema.Literals([1, 2, 3, 4]),
    cost: Schema.Literals([0, 1, 100, 1000]),
    similarity: Schema.Number,
  }),
})
export type Output = typeof Output.Type

const normalizeLineEndings = (text: string) => text.replaceAll("\r\n", "\n")
const detectLineEnding = (text: string): "\n" | "\r\n" => (text.includes("\r\n") ? "\r\n" : "\n")
const convertToLineEnding = (text: string, ending: "\n" | "\r\n") =>
  ending === "\n" ? normalizeLineEndings(text) : normalizeLineEndings(text).replaceAll("\n", "\r\n")

const splitBom = (text: string) =>
  text.startsWith("\uFEFF") ? { bom: true, text: text.slice(1) } : { bom: false, text }
const joinBom = (text: string, bom: boolean) => (bom ? `\uFEFF${text}` : text)
const decodeUtf8 = (content: Uint8Array) => {
  const bom = content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
  return { bom, content, text: new TextDecoder().decode(bom ? content.slice(3) : content) }
}

const previewLines = (value: string, prefix: "+" | "-") => {
  const lines = normalizeLineEndings(value).split("\n")
  const shown = lines.slice(0, 6).map((line) => `${prefix}${line.length > 240 ? `${line.slice(0, 240)}...` : line}`)
  if (lines.length > shown.length) shown.push(`${prefix}...`)
  return shown
}

export const toModelOutput = (output: Output, oldString: string, newString: string) =>
  [
    `Edited file successfully: ${output.files[0]?.file}`,
    `Replacements: ${output.replacements}`,
    ...(output.match.cost === 0
      ? []
      : [
          `Match: tier ${output.match.tier}, cost ${output.match.cost} (${Math.round(output.match.similarity * 100)}% similar)`,
        ]),
    "```diff",
    ...previewLines(oldString, "-"),
    ...previewLines(newString, "+"),
    "```",
  ].join("\n")

/** Deferred V2 edit behavior and UX integrations remain visible at the model-facing seam. */
// TODO: Add formatter integration after V2 formatter runtime exists.
// TODO: Publish watcher/file-edit events after V2 watcher integration exists.
// TODO: Add snapshots / undo after design exists.

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const mutation = yield* LocationMutation.Service
    const files = yield* FileMutation.Service
    const fs = yield* FSUtil.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          sideEffect: "idempotent-write",
          description:
            "Replace text in one file. Prefer this over `write` for any change short of a full rewrite — make the minimal change instead of regenerating the file. Exact or Unicode-punctuation matches cost 0; trailing-whitespace-only drift costs 1 and may auto-apply. Indentation-stripped or similarity matches are reported with their cost but refused, so re-read and retry with the shown candidate. If a safe tier matches more than once, add surrounding context or set replaceAll. Relative paths resolve within the active Location. Absolute paths inside the Location are accepted. Explicit external absolute paths require external_directory approval before edit approval.",
          input: Input,
          output: Output,
          toModelOutput: ({ input, output }) => [
            { type: "text", text: toModelOutput(output, input.oldString, input.newString) },
          ],
          execute: (input, context) => {
            const unableToEdit = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.mapError((error) => {
                  const denial = PermissionV2.denialMessage(error)
                  if (denial) return new ToolFailure({ message: denial })
                  return error instanceof FileMutation.StaleContentError
                    ? new ToolFailure({
                        message: "File changed after permission approval. Read it again before editing.",
                      })
                    : new ToolFailure({ message: `Unable to edit ${input.path}` })
                }),
              )

            return Effect.gen(function* () {
              const permissionSource = {
                type: "tool" as const,
                messageID: context.assistantMessageID,
                callID: context.toolCallID,
              }
              if (input.oldString === input.newString) {
                return yield* new ToolFailure({
                  message: "No changes to apply: oldString and newString are identical.",
                })
              }
              if (input.oldString === "") {
                return yield* new ToolFailure({
                  message: "oldString must not be empty. Use write to create or overwrite a file.",
                })
              }

              const target = yield* unableToEdit(mutation.resolve({ path: input.path, kind: "file" }))
              const external = target.externalDirectory
              if (external) {
                yield* unableToEdit(
                  permission.assert({
                    ...LocationMutation.externalDirectoryPermission(external, "write"),
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: permissionSource,
                  }),
                )
              }

              yield* unableToEdit(
                permission.assert({
                  action: "edit",
                  resources: [target.resource],
                  targets: [{ resource: target.resource, canonical: target.canonical }],
                  attachmentPaths: [...(context.attachmentPaths ?? [])],
                  save: ["*"],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: permissionSource,
                }),
              )
              const source = decodeUtf8(yield* unableToEdit(fs.readFile(target.canonical)))
              const ending = detectLineEnding(source.text)
              const oldString = convertToLineEnding(input.oldString, ending)
              const newString = convertToLineEnding(input.newString, ending)
              const match = findMatch(source.text, oldString)
              if (!match.matched) {
                const best = match.best
                return yield* new ToolFailure({
                  message:
                    "Could not find oldString in the file." +
                    (best === undefined
                      ? ""
                      : ` Closest candidate: tier ${best.tier}, cost ${best.cost}, ${Math.round(best.similarity * 100)}% similar:\n${previewLines(best.text, "-").join("\n")}`),
                })
              }
              const first = match.candidates[0]
              if (first.cost > AUTO_APPLY_COST_CEILING) {
                return yield* new ToolFailure({
                  message:
                    `Closest candidate matched at tier ${first.tier}, cost ${first.cost}, ` +
                    `${Math.round(first.similarity * 100)}% similar — above the auto-apply ceiling ` +
                    `${AUTO_APPLY_COST_CEILING}. Re-read the candidate and retry with exact text:\n` +
                    previewLines(first.text, "-").join("\n"),
                })
              }
              if (match.candidates.length > 1 && input.replaceAll !== true)
                return yield* new ToolFailure({
                  message:
                    first.tier === 1 && match.candidates.every((item) => item.text === oldString)
                      ? "Found multiple exact matches for oldString. Provide more surrounding context or set replaceAll to true."
                      : `Found multiple tier-${first.tier} matches at cost ${first.cost}. ` +
                        "Provide more surrounding context or set replaceAll to true.",
                })

              const selected = input.replaceAll === true ? match.candidates : [first]
              const replacement = replaceMatches(source.text, selected, newString)
              const replaced = replacement.content
              const counts = diffLines(source.text, replaced).reduce(
                (result, item) => ({
                  additions: result.additions + (item.added ? (item.count ?? 0) : 0),
                  deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
                }),
                { additions: 0, deletions: 0 },
              )
              const next = splitBom(replaced)
              const result = yield* unableToEdit(
                files.writeIfUnchanged({
                  target,
                  expected: source.content,
                  content: joinBom(next.text, source.bom || next.bom),
                }),
              )
              return {
                files: [
                  {
                    file: result.resource,
                    patch: createTwoFilesPatch(result.resource, result.resource, source.text, replaced),
                    status: "modified" as const,
                    ...counts,
                  },
                ],
                replacements: replacement.replacements,
                match: { tier: first.tier, cost: first.cost, similarity: first.similarity },
              } satisfies Output
            })
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/edit",
  layer,
  deps: [ToolRegistry.node, LocationMutation.node, FileMutation.node, FSUtil.node, PermissionV2.node],
})
