export * as SkillTool from "./skill"

import path from "path"
import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { SkillV2 } from "../skill"
import { PermissionV2 } from "../permission"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { XmlText } from "../util/xml-text"

export const name = "skill"
const FILE_LIMIT = 10

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from the available skills list" }),
})

export const Output = Schema.Struct({
  name: Schema.String,
  directory: Schema.String,
  output: Schema.String,
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill name must match one of the available skills in the system context.",
].join("\n")

/** Every structural tag this wrapper emits. Forging an OPENING one invents a second block. */
const SENTINELS = ["</skill_content>", "<skill_content", "<skill_files>", "</skill_files>", "<file>"] as const

export const toModelOutput = (skill: SkillV2.Info, files: ReadonlyArray<string>) => {
  const directory = path.dirname(skill.location)
  return [
    // The NAME is metadata and is escaped; `content` below deliberately is NOT — it is the
    // instructions the user chose to load, and escaping it would corrupt every skill that shows
    // markup in an example. See util/xml-text.ts.
    `<skill_content name="${XmlText.escape(skill.name)}">`,
    // Escaped here TOO, not only in the attribute above: a name carrying `</skill_content>` would
    // otherwise close the block from inside this heading, and everything after it would read to the
    // model as text outside the skill rather than as the skill's own words.
    `# Skill: ${XmlText.escape(skill.name)}`,
    "",
    // NOT escaped — a skill's body is instructions and keeps its markup. Only the wrapper's own
    // structural tags are neutralised, because content carrying `</skill_content>` closed this block
    // from the inside and made its next line read as text outside the skill. See util/xml-text.ts.
    XmlText.neutralizeSentinels(skill.content.trim(), SENTINELS),
    "",
    `Base directory for this skill: ${directory}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    ...files.map((file) => `<file>${XmlText.escape(file)}</file>`),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const fs = yield* FSUtil.Service
    const skills = yield* SkillV2.Service
    const permission = yield* PermissionV2.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const current = yield* skills.list()
              const skill = current.find((skill) => skill.name === input.name)
              if (!skill) return yield* unableToLoad(input.name)
              return yield* Effect.gen(function* () {
                yield* permission.assert({
                  action: name,
                  resources: [skill.name],
                  save: [skill.name],
                  sessionID: context.sessionID,
                  agent: context.agent,
                  source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                })
                const directory = path.dirname(skill.location)
                const files =
                  path.basename(skill.location) === "SKILL.md"
                    ? (yield* fs.glob("**/*", { cwd: directory, absolute: true, include: "file", dot: true }))
                        .filter((file) => path.basename(file) !== "SKILL.md")
                        .toSorted()
                        .slice(0, FILE_LIMIT)
                    : []
                return {
                  name: skill.name,
                  directory,
                  output: toModelOutput(skill, files),
                }
                // 🔴 1J. This was `Effect.mapError((error) => unableToLoad(input.name, error))`,
                // which gave a permission REFUSAL the same sentence as a MISSING skill file — two
                // different situations, one of which the model can act on and one of which it
                // cannot. `permission.assert` is the only thing inside this block that can be
                // denied, so putting `denialMessage` ahead of the fallback is the whole fix; the
                // "Unable to load skill" wording still covers a genuine load failure (the glob, a
                // vanished file) and the not-found arm above is untouched.
              }).pipe(Effect.mapError(Tool.absorb(() => `Unable to load skill ${input.name}`)))
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, FSUtil.node, SkillV2.node, PermissionV2.node],
})
