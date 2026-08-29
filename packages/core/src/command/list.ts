export * as CommandList from "./list"

import { Effect } from "effect"
import { Command } from "@novaclaw/schema/command"
import { CommandV2 } from "../command"
import { Config } from "../config"
import { ProjectFileCache } from "../project-file-cache"
import { SkillV2 } from "../skill"
import { SkillInvocation } from "../skill/invocation"
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

/**
 * The user's saved "Show it for me to run" choices, folded across the config documents.
 *
 * ⚠️ Read THROUGH `config.entries()` on every call rather than hoisted, which is the same ruling-3
 * discipline the Config layer itself records: a settings change is not a reboot, and this list is
 * re-fetched by the composer rather than materialised, so there is nothing to invalidate and no
 * reload domain to register.
 *
 * Later documents win per key — the same last-writer order `SETTINGS_KEYS` gives every whole-value
 * settings key. In practice there is exactly one settings document today.
 */
const savedInvocation = Effect.fn("CommandList.savedInvocation")(function* () {
  const config = yield* Config.Service
  let store: Record<string, SkillInvocation.Choice> = {}
  for (const entry of yield* config.entries()) {
    if (entry.type !== "document") continue
    const declared = entry.info.skill_invocation
    if (declared) store = { ...store, ...declared }
  }
  return store as SkillInvocation.Store
})

/**
 * The skill ids the folder's own `novaclaw.json` hides — the PROJECT half of "Show it for me to run".
 *
 * ⚠️ Resolved from the LOCATION's directory (`ProjectFileCache.LocalService`) because that is the
 * only folder this list has. The
 * permission evaluator uses the SESSION's working folder instead, and it can — an assert carries a
 * session id. This list does not — the composer fetches it per location, before any session exists
 * — and a location's directory is the folder the user opened. The two answers differ only for a
 * session moved elsewhere after it was created, which is the same folder every other per-location
 * surface in this list already answers for.
 *
 * ⚠️ Read through `ProjectFileCache` rather than resolving the file here, so this is the FIFTH
 * consumer of ONE read of one `novaclaw.json` and not a fifth cache over it. Two caches over one
 * file disagree across a mid-window edit, and a folder whose menu comes from the file it used to be
 * while its permissions come from the file it now is, is the worst of both.
 *
 * 🔴 Already narrowed: `ProjectFileCache` stores `ProjectFile.narrowSkills(...).hidden`, so a folder
 * asking to SHOW a skill the user hid never reaches this function at all. A project may hide, never
 * un-hide.
 */
const projectVisibility = Effect.fn("CommandList.projectVisibility")(function* () {
  const project = yield* ProjectFileCache.LocalService
  const entry = yield* project.entry
  return { hidden: entry.skills, faulted: ProjectFileCache.fault(entry) !== undefined }
})

export const list: Effect.Effect<
  Command.Info[],
  never,
  CommandV2.Service | SkillV2.Service | ExternalCommandSource.Service | Config.Service | ProjectFileCache.LocalService
> = Effect.gen(function* () {
  const commands = yield* CommandV2.Service
  const skills = yield* SkillV2.Service
  const external = yield* ExternalCommandSource.Service
  // The HUMAN half of the two skill-invocation switches. It gates THIS list and nothing else: the
  // composer's slash popover renders it and the session command op dispatches from it, so hiding a
  // skill here removes it from the user's own menu and changes nothing about what an agent may do.
  // The agent half is the `skill` permission action — see `core/src/skill/invocation.ts`.
  const invocation = yield* savedInvocation()
  // ⚠️ Resolved ONCE per list rather than per skill: a mid-list TTL expiry would otherwise let two
  // skills in one popover be judged against two different readings of one file.
  const visibility = yield* projectVisibility()

  const result: Command.Info[] = []
  const seen = new Set<string>()
  for (const cmd of yield* commands.list()) {
    seen.add(cmd.name)
    result.push({ ...cmd, source: "command", hints: hints(cmd.template) })
  }
  for (const skill of yield* skills.list()) {
    // The file may contain a hide declaration we cannot currently read. Suppress project-visible
    // skills until it is fixed/unlocked/upgraded instead of treating the empty presentation
    // fallback as "hide nothing". Built-in commands remain available, including repair paths.
    if (visibility.faulted) continue
    if (seen.has(skill.name)) continue
    // ⚠️ NOT added to `seen` when hidden. `seen` is the collision ledger — it exists so a CommandV2
    // command outranks a same-named skill which outranks a same-named MCP prompt. Marking a hidden
    // skill as seen would let it suppress the MCP prompt behind it, so hiding one entry would
    // silently delete a different one.
    if (!SkillInvocation.showsToUser(invocation, visibility.hidden, skill.name)) continue
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
