export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"
import { XmlText } from "../util/xml-text"

const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
})
export type Summary = typeof Summary.Type

/**
 * The resident skills INDEX — every permitted skill's name and description, in every request.
 *
 * ⚠️ **This is a TIER-2 disclosure and it is unbounded** (`notes/reports/disclosure-tiers-2026-08-12.md`).
 * Measured 2026-08-12 against this very function: **~157 bytes per skill**, so ~142 skills cost more
 * than the entire 21-tool resident schema set (22 235 bytes) and 1 000 skills is ~40k prompt tokens on
 * every turn — the wall the tool catalogue is kept away from.
 *
 * 157 B/skill is CHEAP per item next to 932 B/tool, and that is exactly why it is worth saying: tier 1
 * has a ratchet AND deferral behind `tool_search`, and this has neither. A cheaper per-item cost with
 * no bound loses to a dearer one with a bound as soon as the count grows.
 *
 * ⛔ Do not "fix" it by truncating the list. A silently partial index hides skills the user installed,
 * which is the same defect the skill-pull index cap refuses by rejecting an oversized source WHOLE.
 * The escape is the one the tool catalogue already proved: a count plus a search.
 *
 * Exported so `skill-guidance-index.test.ts` can ratchet it — the resident tool set sat at 99.4% of
 * its ceiling for days because nothing measured it until someone looked.
 */
export const render = (skills: ReadonlyArray<Summary>) =>
  [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    ...(skills.length === 0
      ? ["No skills are currently available."]
      : [
          "<available_skills>",
          ...skills.flatMap((skill) => [
            "  <skill>",
            // ESCAPED, because a skill's metadata is the least-trusted input in this document.
            // Unescaped, one skill forged a second <skill> entry naming itself whatever it liked.
            `    <name>${XmlText.escape(skill.name)}</name>`,
            `    <description>${XmlText.escape(skill.description ?? "")}</description>`,
            "  </skill>",
          ]),
          "</available_skills>",
        ]),
  ].join("\n")

export interface Interface {
  readonly load: (agent: AgentV2.Selection) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SkillGuidance") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection) {
        const agent = selection.info
        if (!agent) return SystemContext.empty
        const permitted = SkillV2.available(yield* skills.list(), agent)
        if (permitted.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
          return SystemContext.empty
        const available = permitted
          .flatMap((skill) =>
            skill.description === undefined ? [] : [{ name: skill.name, description: skill.description }],
          )
          .toSorted((a, b) => a.name.localeCompare(b.name))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          codec: Schema.toCodecJson(Schema.Array(Summary)),
          load: Effect.succeed(available),
          baseline: render,
          update: (_previous, current) =>
            [
              "The available skills have changed. This list supersedes the previous available skills list.",
              render(current),
            ].join("\n"),
          removed: () => "Skill guidance is no longer available. Do not use any previously listed skill.",
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })
