/// <reference path="../markdown.d.ts" />

export * as SkillPlugin from "./skill"

import { define } from "./internal"
import { Effect } from "effect"
import { AbsolutePath } from "../schema"
import { SkillV2 } from "../skill"
import customizeNovaclawContent from "./skill/customize-novaclaw.md" with { type: "text" }

export const CustomizeNovaclawContent = customizeNovaclawContent

export const Plugin = define({
  id: "skill",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.skill.transform((draft) => {
      draft.source(
        SkillV2.EmbeddedSource.make({
          type: "embedded",
          skill: SkillV2.Info.make({
            name: "customize-novaclaw",
            // Doubles as the slash-palette blurb — keep it human-readable; the trigger anchors
            // are the nouns (file names + artifact types), not prompt-ese imperatives.
            description:
              "Set up or fix NovaClaw's own configuration: novaclaw.json / novaclaw.jsonc, files under .novaclaw/ or ~/.config/novaclaw/, and NovaClaw agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Not for your own application code or projects that aren't configuring NovaClaw itself.",
            location: AbsolutePath.make("/builtin/customize-novaclaw.md"),
            content: CustomizeNovaclawContent,
          }),
        }),
      )
    })
  }),
})
