import { describe, expect, test } from "bun:test"
import { SystemCompose } from "./system-compose"

/**
 * AN OFFICER IS TOLD IT HAS HANDS — and told how they differ from colleagues.
 *
 * 🔴 Measured on Qwen3.6-35B 2026-08-22. An officer told plainly to *"spawn a fleet of 6 sub-agents"*
 * reached for `colleague` and addressed ITSELF six times, then reasoned *"right, marshal is me — I
 * need spawn"*, searched for `spawn` with `tool_search`, and looped four times without ever calling
 * it. `spawn` was RESIDENT on its horizon throughout.
 *
 * The tool description was fine. The PROMPT never said the capability existed: the only mention of
 * `spawn` anywhere sat inside the vision section, behind an image-modality check, so a text-only
 * model was told nothing at all. Reaching for the one delegation it HAD been told about is the
 * reasonable inference from what it knew.
 */

describe("the delegation section", () => {
  test("an officer that can spawn is told so, in words that forbid the failure", () => {
    const section = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: false })
    expect(section).toBeDefined()
    expect(section).toContain("spawn")
    // 🔴 The measured failure was going LOOKING for a resident tool. The instruction says not to.
    expect(section!.toLowerCase()).toContain("already in your tool list")
  })

  test("pays for a fresh context only with sizeable independent work", () => {
    const section = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: false })!
    expect(section).toContain("SIZEABLE, INDEPENDENT")
    expect(section).toContain("startup and reread cost")
    expect(section).toContain("few tool calls")
  })

  test("does not duplicate delegated work and verifies the result", () => {
    const section = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: false })!
    expect(section).toContain("continue other independent work")
    expect(section).toContain("Do not redo")
    expect(section).toContain("verify its evidence or changed state")
  })

  test("size pin: conditional delegation guidance stays compact", () => {
    const section = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: true })!
    expect(section.length).toBeLessThan(1_500)
  })

  test("a colleague grant is described as somebody ELSE's work, and forbids self-address", () => {
    const section = SystemCompose.delegationSection({ canSpawn: false, canAddressColleagues: true })
    expect(section).toBeDefined()
    expect(section!.toLowerCase()).toContain("never address yourself")
  })

  test("🔴 with BOTH, the difference is stated — which is the part the model got wrong", () => {
    // Naming either alone leaves the model to guess how it relates to the other, and that guess is
    // exactly what failed. What separates them is identity, not capability.
    const section = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: true })!
    expect(section).toContain("`spawn` for more hands")
    expect(section.toLowerCase()).toContain("somebody else")
    // The tie-break for the literal phrasing the owner used.
    expect(section.toLowerCase()).toContain("sub-agents are what is being asked for")
  })

  test("neither capability is silence — never a section describing tools the turn cannot call", () => {
    expect(SystemCompose.delegationSection({ canSpawn: false, canAddressColleagues: false })).toBeUndefined()
  })

  test("it composes as kernel material, after the agent's own brief", () => {
    // A persona saying "do everything yourself" must not sit on top of what the runtime can do.
    const parts = SystemCompose.composeSystemParts({
      persona: "You are Marshal.",
      agentSystem: "Do the work personally.",
      delegation: SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: true }),
      base: "kernel base",
    })
    const delegation = SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: true })!
    expect(parts.indexOf(delegation)).toBeGreaterThan(parts.indexOf("Do the work personally."))
  })
})
