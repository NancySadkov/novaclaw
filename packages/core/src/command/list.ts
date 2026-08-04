export * as CommandList from "./list"

import { Effect } from "effect"
import { Command } from "@novaclaw/schema/command"
import { CommandV2 } from "../command"
import { SkillV2 } from "../skill"
import { ExternalCommandSource } from "./external-command-source"
import { SkillCommand } from "./skill-command"

// P6 (/command reconciliation): the ONE slash-command list — CommandV2 (built-ins +
// store/markdown + plugin-registered commands, exactly what the session command op
// dispatches) ∪ skills (every skill is slash-invokable, V1 parity) ∪ the MCP
// ExternalCommandSource. Collision precedence mirrors the dispatch fallback order:
// CommandV2 > skill > MCP. Each entry carries the presentation metadata the composer
// renders (`source` badge + `$1..$N` argument hints); MCP templates resolve lazily at
// dispatch, so their listed template is "". Shared by the V2 `/api/command` route and
// the legacy instance `/command` route so the two can never diverge again.

/** Extract `$1..$N` + `$ARGUMENTS` placeholders from a command template, in order. */
export function hints(template: string) {
  const result: string[] = []
  const numbered = template.match(/\$\d+/g)
  if (numbered) {
    for (const match of [...new Set(numbered)].sort()) result.push(match)
  }
  if (template.includes("$ARGUMENTS")) result.push("$ARGUMENTS")
  return result
}

export const list: Effect.Effect<
  Command.Info[],
  never,
  CommandV2.Service | SkillV2.Service | ExternalCommandSource.Service
> = Effect.gen(function* () {
  const commands = yield* CommandV2.Service
  const skills = yield* SkillV2.Service
  const external = yield* ExternalCommandSource.Service

  const result: Command.Info[] = []
  const seen = new Set<string>()
  for (const cmd of yield* commands.list()) {
    seen.add(cmd.name)
    result.push({ ...cmd, source: "command", hints: hints(cmd.template) })
  }
  for (const skill of yield* skills.list()) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push({
      name: skill.name,
      template: SkillCommand.template(skill),
      ...(skill.description !== undefined ? { description: skill.description } : {}),
      source: "skill",
      hints: [],
    })
  }
  for (const [name, entry] of yield* external.entries()) {
    if (seen.has(name)) continue
    result.push({
      name,
      template: "",
      ...(entry.description !== undefined ? { description: entry.description } : {}),
      source: "mcp",
      hints: [...entry.hints],
    })
  }
  return result
})
