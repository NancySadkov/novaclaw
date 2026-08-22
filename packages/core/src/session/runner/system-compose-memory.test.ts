import { describe, expect, test } from "bun:test"
import { SystemCompose } from "./system-compose"

// A THROWAWAY MUST KNOW IT IS ONE.
//
// 🔴 Measured live on holo3.1 2026-08-22: a colleague configured `memory: "none"` was asked to
// remember something for later and answered *"Yes, I've stored the information."* It had written a
// TODO. The disclosure existed in the Contacts dialog (which tells the USER) and in the `self` tool
// (which a model reads only if it thinks to ask about itself); the prompt said nothing, so the model
// assumed it had memory — as almost every model it was trained on does.

describe("the memory stance section", () => {
  test("a throwaway is TOLD, in words it can act on", () => {
    const section = SystemCompose.memoryStanceSection("none")
    expect(section).toBeDefined()
    // The instruction has to survive being skimmed: the fact, and what to do instead.
    expect(section).toContain("NO long-term memory")
    expect(section!.toLowerCase()).toContain("say plainly that you cannot")
    // 🔴 The sentence aimed at the measured failure. Without it the model has been told a fact and
    // not told which answer that fact forbids.
    expect(section).toContain("Never")
    expect(section).toContain("stored")
  })

  test("a colleague WITH memory gets nothing — silence is the correct default", () => {
    // Having memory is the assumption a model already arrives with, so stating it would be dead text
    // in nearly every prompt. Same rule as `toolDiscoverySection`'s zero-count case.
    expect(SystemCompose.memoryStanceSection("own")).toBeUndefined()
  })

  test("an UNDECLARED stance gets nothing either", () => {
    // `undefined` is a colleague that never set the field, which defaults to having memory. Emitting
    // the throwaway text here would tell most colleagues on the roster something false about
    // themselves — worse than the silence it replaced.
    expect(SystemCompose.memoryStanceSection(undefined)).toBeUndefined()
  })

  test("it composes as KERNEL material a persona cannot bury", () => {
    // Ordered after the agent's own system prompt and the persona, so a brief that says "I'll
    // remember that for you" cannot sit on top of the fact that nothing is kept.
    const parts = SystemCompose.composeSystemParts({
      persona: "You are Mnemo. You never forget.",
      agentSystem: "Keep notes for the user.",
      memoryStance: SystemCompose.memoryStanceSection("none"),
      base: "kernel base",
    })
    expect(parts.indexOf(SystemCompose.memoryStanceSection("none")!)).toBeGreaterThan(
      parts.indexOf("Keep notes for the user."),
    )
  })
})
