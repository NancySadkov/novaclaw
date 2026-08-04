export * as SkillCommand from "./skill-command"

import path from "path"
import type { SkillV2 } from "../skill"

// Project a skill onto a slash-command template (the V1 `Command.Service` skill mapping,
// re-homed to core so the session `command` op and the `/command` list handler share one
// definition). Skills with a real file location get the base-directory note so relative
// scripts/references resolve; embedded built-ins (synthetic `/builtin/...` locations) don't.

const BUILTIN_DIR = "/builtin"

export function template(skill: SkillV2.Info): string {
  const dir = path.dirname(skill.location)
  if (dir === BUILTIN_DIR || dir === "." || skill.location === "<built-in>") return skill.content
  return [
    skill.content,
    "",
    `Base directory for this skill: ${dir}`,
    "Relative paths in this skill (e.g., scripts/, references/) are relative to this base directory.",
  ].join("\n")
}
