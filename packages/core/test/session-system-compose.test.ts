import { describe, expect, it } from "bun:test"
import { Schema } from "effect"
import { ConfigProvider } from "@novaclaw/core/config/provider"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"

// Pure unit test for the per-model PRE-PROMPT composition (owner 2026-07-29, todo/assorted.md).
// The two binding claims of the feature, proven without executing the live runner:
//   (a) INERT by default — with no pre-prompt the composed system prompt is byte-identical to today;
//   (b) when set, the pre-prompt appears exactly once, in the correct slot (after the persona
//       baseline, before the base context and every other part).

describe("SystemCompose — per-model pre-prompt composition", () => {
  // The named parts the runner assembles, minus the pre-prompt — the "today" baseline. Order here
  // MUST match the array in llm.ts: persona, expertiseHint, tierHint, override, agent, base.
  // (`persona` composed first, `base` last — see system-compose.ts and persona.ts.)
  // ⚠️ `memoryRecall` is deliberately NOT here: it left the system prompt on 2026-08-05 because it is
  // the one per-turn-volatile part and it was destroying the server-side prefix cache. It now rides
  // the message tail (llm.ts). See the ⚠️ header in system-compose.ts.
  // ⚠️ `projectScope` and `toolDiscovery` are omitted alongside `modelPrePrompt` on purpose: this
  // file's whole claim is "byte-identical to today when the OPTIONAL sections are absent", so every
  // optional section has to be absent from the baseline. `projectScope`'s own composition is covered
  // in `test/unattended-bash-safe-mode.test.ts`.
  const baseParts: Required<
    Omit<SystemCompose.SystemPromptParts, "modelPrePrompt" | "projectScope" | "toolDiscovery">
  > = {
    persona: "You are Nova.",
    expertiseHint: "Explain in plain language.",
    tierHint: "You are a small local model.",
    systemPromptOverride: "Session override text.",
    agentSystem: "Build agent instructions.",
    base: "Initial context (kernel base).",
  }

  const todayOrder = [
    baseParts.persona,
    baseParts.expertiseHint,
    baseParts.tierHint,
    baseParts.systemPromptOverride,
    baseParts.agentSystem,
    baseParts.base,
  ].filter((p): p is string => p !== undefined && p.length > 0)

  it("(a) is byte-identical to today when no pre-prompt is set", () => {
    // undefined pre-prompt slot
    expect(SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: undefined })).toEqual(todayOrder)
    // an empty / whitespace-only authored value is inert (the section helper returns undefined)
    expect(SystemCompose.modelPrePromptSection(undefined)).toBeUndefined()
    expect(SystemCompose.modelPrePromptSection("")).toBeUndefined()
    expect(SystemCompose.modelPrePromptSection("   \n\t ")).toBeUndefined()
    expect(
      SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: SystemCompose.modelPrePromptSection("  ") }),
    ).toEqual(todayOrder)
    // Negative control for the filter's `part.length > 0` sub-clause (NOT just `!== undefined`): an
    // empty-STRING upstream part — llm.ts feeds systemPromptOverride="" and agentSystem="" — must be
    // DROPPED, exactly as the pre-feature filter did. Without this case a regression weakening the
    // predicate to `!== undefined` would leak "" into the system array yet pass every other assertion.
    expect(
      SystemCompose.composeSystemParts({ ...baseParts, systemPromptOverride: "", modelPrePrompt: undefined }),
    ).toEqual(todayOrder.filter((p) => p !== baseParts.systemPromptOverride))
  })

  it("(b) inserts the pre-prompt exactly once, after the persona and before the base", () => {
    const text = "Never wrap replies in markdown code fences."
    const section = SystemCompose.modelPrePromptSection(text)
    expect(section).toBeDefined()

    const parts = SystemCompose.composeSystemParts({ ...baseParts, modelPrePrompt: section })

    // exactly one occurrence of the section, and the user's text appears exactly once overall
    expect(parts.filter((p) => p === section)).toHaveLength(1)
    expect(parts.join("\n\n").split(text)).toHaveLength(2)

    // correct slot: persona leads (index 0), the pre-prompt is immediately after it (index 1), and it
    // is strictly before the base context and the agent's own persona/prompt.
    expect(parts.indexOf(baseParts.persona)).toBe(0)
    const idx = parts.indexOf(section!)
    expect(idx).toBe(1)
    expect(idx).toBeLessThan(parts.indexOf(baseParts.agentSystem))
    expect(idx).toBeLessThan(parts.indexOf(baseParts.base))

    // and it is a distinct, labelled section (reads as "about this model", not a task instruction)
    expect(section!.startsWith(SystemCompose.MODEL_PREPROMPT_LABEL)).toBe(true)

    // every other part keeps its position — the composed prompt is exactly today's order with the one
    // section spliced in after the persona.
    expect(parts).toEqual([todayOrder[0]!, section!, ...todayOrder.slice(1)])
  })

  it("leads with the pre-prompt when the persona baseline is disabled (still inert-safe)", () => {
    const section = SystemCompose.modelPrePromptSection("Answer in one paragraph.")!
    const withSection = SystemCompose.composeSystemParts({ ...baseParts, persona: undefined, modelPrePrompt: section })
    expect(withSection[0]).toBe(section)
    // and with no section, a persona-less prompt is byte-identical to today-without-persona
    expect(SystemCompose.composeSystemParts({ ...baseParts, persona: undefined })).toEqual(todayOrder.slice(1))
  })

  it("carries prePrompt as an OPTIONAL config field (no migration; old configs decode unchanged)", () => {
    const decodeEntry = Schema.decodeUnknownSync(ConfigProvider.ModelEntry)
    // flat models-primary entry: absent → undefined; present → carried
    expect(decodeEntry({ name: "qwen" }).prePrompt).toBeUndefined()
    expect(decodeEntry({ name: "qwen", prePrompt: "Stop over-apologising." }).prePrompt).toBe("Stop over-apologising.")

    // nested providers.<id>.models.<id> path carries it too (the catalog plugin reads it from here)
    const provider = Schema.decodeUnknownSync(ConfigProvider.Info)({ models: { m1: { prePrompt: "nested works" } } })
    expect(provider.models?.["m1"]?.prePrompt).toBe("nested works")
  })

  // The tool-discovery section is kernel material for the same reason project scope is: the list
  // being partial is a fact about the runtime, not a preference a persona may drop.
  it("sits in the kernel material, after anything a persona or agent prompt can say", () => {
    const section = SystemCompose.toolDiscoverySection(9)!
    const parts = SystemCompose.composeSystemParts({ ...baseParts, toolDiscovery: section })
    const index = parts.indexOf(section)
    expect(index).toBeGreaterThan(parts.indexOf(baseParts.agentSystem))
    expect(index).toBeGreaterThan(parts.indexOf(baseParts.systemPromptOverride))
    expect(index).toBeLessThan(parts.indexOf(baseParts.base))
  })
})

describe("toolDiscoverySection — the model must know its tool list is partial", () => {
  // 🔴 The owner's report on Holo-3.1: asked for the full list of its tools, it answered from the
  // resident set and never searched. Nothing had ever told it more existed.
  it("names the COUNT, so it is a fact rather than a hedge", () => {
    const section = SystemCompose.toolDiscoverySection(37)!
    expect(section).toContain("37 more tools")
    expect(section).toContain("tool_search")
    // The two moments it must fire: being asked what it can do, and finding no listed tool fits.
    expect(section).toContain("what you can do")
    expect(section).toContain("no listed tool fits")
  })

  it("says ONE tool in the singular", () => {
    expect(SystemCompose.toolDiscoverySection(1)!).toContain("1 more tool is")
    expect(SystemCompose.toolDiscoverySection(2)!).toContain("2 more tools are")
  })

  // ⚠️ An instruction describing tools that do not exist is a false description, and would be dead
  // text in every prompt with no catalogue.
  it("is ABSENT when nothing is deferred", () => {
    expect(SystemCompose.toolDiscoverySection(0)).toBeUndefined()
    expect(SystemCompose.toolDiscoverySection(-1)).toBeUndefined()
  })

})

