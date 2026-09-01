import { describe, expect, test } from "bun:test"
import { SystemAccounting } from "./system-accounting"
import { SystemCompose } from "./system-compose"

// The per-block prompt instrument the tool-scale work was missing, and `notes/named-agents.md` needs.

describe("per-block accounting", () => {
  test("every block a prompt actually has is counted, in emission order", () => {
    const accounting = SystemAccounting.of({ persona: "abcd", agentSystem: "efghijkl", base: "mn" })
    expect(accounting.blocks.map((b) => b.block)).toEqual(["persona", "agentSystem", "base"])
    expect(accounting.chars).toBe(14)
  })

  test("an ABSENT block is omitted, never reported as zero", () => {
    // "This block is here and empty" and "this session has no project scope" are different facts, and
    // a table full of zeroes is how a reader stops reading the table.
    const accounting = SystemAccounting.of({ persona: "abcd", projectScope: undefined, memoryStance: "" })
    expect(accounting.blocks.map((b) => b.block)).toEqual(["persona"])
  })

  test("the order matches what `composeSystemParts` actually emits", () => {
    // 🔴 A hand-kept order that drifts from the composer reports a prompt nobody sends. Built from
    // one block per name so the comparison is unambiguous.
    const parts = Object.fromEntries(SystemAccounting.BLOCKS.map((block) => [block, block])) as never
    expect(SystemCompose.composeSystemParts(parts)).toEqual([...SystemAccounting.BLOCKS])
  })

  test("the largest block is named — that is what a regression has to point at", () => {
    const accounting = SystemAccounting.of({ persona: "a".repeat(40), base: "b".repeat(400) })
    expect(accounting.largest?.block).toBe("base")
  })

  test("an empty prompt has no largest block rather than a zero one", () => {
    expect(SystemAccounting.of({}).largest).toBeUndefined()
    expect(SystemAccounting.report(SystemAccounting.of({}))).toBe("system prompt: empty")
  })

  // 🔴 THE PROPERTY `named-agents.md` IS AFTER: a chit-chat role packs materially less than an
  // engineering one. This states it as a MEASUREMENT the instrument can make, not as a claim — what
  // the two roles actually pack is a product decision that has not been made yet, so this asserts the
  // instrument can tell them apart rather than that they already differ.
  test("two roles' prompts are comparable by total and by block", () => {
    const chitchat = SystemAccounting.of({ persona: "You are Iris. Be warm and brief.", base: "kernel" })
    const engineering = SystemAccounting.of({
      persona: "You are Theron.",
      agentSystem: "x".repeat(2_000),
      toolDiscovery: "y".repeat(500),
      projectScope: "z".repeat(300),
      base: "kernel",
    })
    expect(engineering.tokens).toBeGreaterThan(chitchat.tokens * 5)
    // …and the report names WHICH block carries the difference, which is the whole point of counting
    // per block rather than measuring the total.
    expect(engineering.largest?.block).toBe("agentSystem")
  })

  test("the report shows shares of the SYSTEM PROMPT, and says so by summing to ~100", () => {
    const accounting = SystemAccounting.of({ persona: "a".repeat(100), base: "b".repeat(300) })
    const shares = [...SystemAccounting.report(accounting).matchAll(/(\d+)%/g)].map((m) => Number(m[1]))
    expect(shares.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(99)
    expect(shares.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(101)
  })
})
