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
            description:
              "Use ONLY when the user is editing or creating novaclaw's own configuration: novaclaw.json, novaclaw.jsonc, files under .novaclaw/, or files under ~/.config/novaclaw/. Also use when creating or fixing novaclaw agents, subagents, commands, skills, plugins, MCP servers, or permission rules. Do not use for the user's own application code, or for any project that is not configuring novaclaw itself.",
            location: AbsolutePath.make("/builtin/customize-novaclaw.md"),
            content: CustomizeNovaclawContent,
          }),
        }),
      )
    })
  }),
})
