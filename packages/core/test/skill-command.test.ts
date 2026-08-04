// P6 (/command reconciliation): the skill→slash-command template projection shared by the
// session command op's fallback and the /command list handler. Real-file skills carry the
// base-directory note (relative scripts/references resolve against it); embedded built-ins
// (synthetic /builtin/... locations) must not — their "directory" is not a real path.
import { describe, expect, test } from "bun:test"
import { SkillCommand } from "@novaclaw/core/command/skill-command"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { SkillV2 } from "@novaclaw/core/skill"

function skill(location: string, content = "Do the thing."): SkillV2.Info {
  return { name: "demo", description: "a demo skill", location: AbsolutePath.make(location), content }
}

describe("SkillCommand.template (P6)", () => {
  test("a real skill file gets the base-directory note", () => {
    const result = SkillCommand.template(skill("/home/user/.config/novaclaw/skills/demo/SKILL.md"))
    expect(result).toContain("Do the thing.")
    expect(result).toContain("Base directory for this skill: /home/user/.config/novaclaw/skills/demo")
    expect(result).toContain("Relative paths in this skill")
  })

  test("an embedded built-in skill gets NO base-directory note", () => {
    const result = SkillCommand.template(skill("/builtin/example.md", "Built-in body."))
    expect(result).toBe("Built-in body.")
  })

  test("the content always leads the template", () => {
    const result = SkillCommand.template(skill("/skills/x/SKILL.md", "First line."))
    expect(result.startsWith("First line.")).toBe(true)
  })
})
