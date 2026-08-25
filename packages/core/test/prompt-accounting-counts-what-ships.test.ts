import { describe, expect, test } from "bun:test"
import { SystemAccounting } from "@novaclaw/core/session/runner/system-accounting"
import { SystemCompose } from "@novaclaw/core/session/runner/system-compose"

/**
 * THE INSTRUMENT MUST COUNT WHAT ACTUALLY SHIPS.
 *
 * `BLOCKS` was a second hand-written copy of the block names, and it was already stale:
 * `composeSystemParts` emits `delegation` and `workspace`, neither of which was listed — so the
 * accounting UNDERCOUNTED every colleague turn, which is exactly the turn whose prompt anyone would
 * want measured. A measurement kept in a different list from the thing measured drifts, and the drift
 * is invisible because each side looks correct on its own.
 *
 * ⚠️ These assert the RELATIONSHIP, not a hand-listed set. A test that names the eleven blocks would
 * be a third copy, stale on the same day as the second.
 */

const filled = (blocks: readonly string[]) =>
  Object.fromEntries(blocks.map((block) => [block, `<${block}>`])) as unknown as SystemCompose.SystemPromptParts

describe("what the accounting counts", () => {
  test("🔴 EVERY part that composes is a block that counts", () => {
    // The claim, stated as a relationship: nothing can reach the model uncounted.
    const parts = filled(SystemAccounting.BLOCKS)
    const counted = SystemAccounting.of(parts).blocks.map((entry) => entry.block)
    const composed = SystemCompose.systemPartsInOrder(parts).map((part) => part.block)
    expect(counted).toEqual(composed)
  })

  test("🔴 …including the two that were missing — delegation and workspace", () => {
    // Named because they are the ones that were lost, and because a purely structural test above
    // would pass if BOTH lists lost the same block.
    expect(SystemAccounting.BLOCKS).toContain("delegation")
    expect(SystemAccounting.BLOCKS).toContain("workspace")
  })

  test("🔴 a colleague turn is no longer undercounted", () => {
    // The measured consequence: with delegation and workspace present, the instrument's total is the
    // whole prompt rather than the prompt minus two blocks.
    const parts = filled(SystemAccounting.BLOCKS)
    const accounting = SystemAccounting.of(parts)
    const composedChars = SystemCompose.composeSystemParts(parts).join("").length
    expect(accounting.chars).toBe(composedChars)
  })

  test("⚠️ the block list is not vacuously empty", () => {
    // It is derived by calling `systemPartsInOrder` with nothing populated. If that ever returned
    // only the present parts, this would silently become a list of none and count nothing.
    expect(SystemAccounting.BLOCKS.length).toBeGreaterThan(10)
  })

  test("an absent block is OMITTED, not counted as zero", () => {
    // Preserved behaviour: a zero row reads as "here and empty", a different fact from "not here".
    const accounting = SystemAccounting.of({ persona: "hello" } as unknown as SystemCompose.SystemPromptParts)
    expect(accounting.blocks.map((entry) => entry.block)).toEqual(["persona"])
  })
})
