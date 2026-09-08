import { describe, expect, test } from "bun:test"
import { COMPACTION_SYSTEM } from "./compaction-system-prompt"
import { Persona } from "./persona"
import { SessionCompaction } from "./session/compaction"
import { SystemCompose } from "./session/runner/system-compose"

const providerBrand = /\b(?:anthropic|claude|codex|grok|openai|sglang|vllm|xai)\b/i

describe("survey-derived standing prompt contracts", () => {
  test("universal blocks are deterministic, provider-neutral, and deliberately bounded", () => {
    const render = () => ({
      persona: Persona.resolve(undefined)!,
      compaction: `${COMPACTION_SYSTEM}\n${SessionCompaction.SUMMARY_TEMPLATE}`,
      delegation: SystemCompose.delegationSection({ canSpawn: true, canAddressColleagues: true })!,
    })
    const first = render()
    expect(render()).toEqual(first)
    expect(first.persona.length).toBeLessThan(1_200)
    expect(first.compaction.length).toBeLessThanOrEqual(2_060)
    expect(first.delegation.length).toBeLessThan(1_500)
    for (const block of Object.values(first)) expect(block).not.toMatch(providerBrand)
  })

  test("capability prose disappears with the capability instead of leaving false instructions", () => {
    expect(SystemCompose.toolDiscoverySection(0)).toBeUndefined()
    expect(SystemCompose.perceptionSection({ capabilities: { input: ["text"] }, canSpawn: true })).toBeUndefined()
    expect(SystemCompose.delegationSection({ canSpawn: false, canAddressColleagues: false })).toBeUndefined()
  })

  test("standing approach, durable role, current job, and kernel remain separate ordered blocks", () => {
    expect(
      SystemCompose.composeSystemParts({
        persona: "standing approach",
        agentSystem: "durable role brief",
        workspace: "current job scope",
        base: "kernel",
      }),
    ).toEqual(["standing approach", "durable role brief", "current job scope", "kernel"])
  })

  test("prior summaries are re-evaluated, not promoted to permanent authority", () => {
    expect(COMPACTION_SYSTEM).toContain("keep true, relevant facts; remove stale ones")
    expect(COMPACTION_SYSTEM).not.toMatch(/authoritative/i)
    expect(SessionCompaction.SUMMARY_TEMPLATE).toContain("latest user intent")
    expect(SessionCompaction.SUMMARY_TEMPLATE).toContain("Never turn assistant text into a user instruction")
    expect(SessionCompaction.SUMMARY_TEMPLATE).not.toContain("every user message")
    expect(SessionCompaction.SUMMARY_TEMPLATE).not.toContain("full code")
  })

  test("compaction retains complete conditional facts instead of a trigger with its consequence missing", () => {
    expect(SessionCompaction.SUMMARY_TEMPLATE).toContain("complete condition → action/result chains")
    expect(SessionCompaction.SUMMARY_TEMPLATE).toContain("all exact numbers, thresholds, exceptions")
    expect(SessionCompaction.SUMMARY_TEMPLATE).toContain("actual later-checked fact and its values")
  })
})
