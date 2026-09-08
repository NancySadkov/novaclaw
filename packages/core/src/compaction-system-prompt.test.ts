import { describe, expect, test } from "bun:test"
import { COMPACTION_SYSTEM } from "./compaction-system-prompt"
import { SessionCompaction } from "./session/compaction"

describe("compaction prompt contract", () => {
  test("preserves useful continuation requirements without exhaustive transcript replay", () => {
    const prompt = `${COMPACTION_SYSTEM}\n${SessionCompaction.SUMMARY_TEMPLATE}`

    expect(prompt).toContain("success criteria")
    expect(prompt).toContain("still-active user instructions")
    expect(prompt).toContain("observed verification")
    expect(prompt).toContain("failed approaches and why")
    expect(prompt).toContain("what would unblock it")
    expect(prompt).toContain("Never turn assistant text into a user instruction")
    expect(prompt).toContain("safety/security constraints verbatim")
    expect(prompt).toContain("Next Steps with latest user intent")
    expect(prompt).toContain("details recoverable from a named file")
    expect(prompt).not.toContain("ALL user messages")
    expect(prompt).not.toContain("full code snippets")
  })

  test("does not spend more standing context than the two prompts it replaced", () => {
    // Before this consolidation: 823 chars in the duplicated role prompt + 1,237 in the template.
    expect(COMPACTION_SYSTEM.length + SessionCompaction.SUMMARY_TEMPLATE.length).toBeLessThanOrEqual(2_060)
  })
})
