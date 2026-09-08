import { describe, expect, test } from "bun:test"
import { ReadTool } from "@novaclaw/core/tool/read"

/**
 * `read` withholds pixels the current request cannot carry (owner, 2026-08-20: *"eviction happens
 * too fast and the model doesn't produce the useful description immediately, so nothing is left of
 * the visual model"*).
 *
 * The mechanism: within ONE assistant turn there is no assistant text between tool calls, so an
 * image opened after the endpoint's cap is reached is necessarily undescribed — `budgetImages` will
 * elide an earlier one to fit it, and measured 2026-08-20 the model does not report the gap, it
 * confabulates (it invented a crown, a shield and a helmet for three evicted glyphs). So the tool
 * returns a sentence instead of the bytes, the turn ends, and the model describes what it holds.
 *
 * ⚠️ This file pins the NOTICE and its trigger arithmetic. The prerequisite it used to name — the
 * cap being unknown on a cold turn, so this gate could never fire — is CLOSED as of 2026-08-20:
 * `resolveImageLimit` floors an unknown cap at 1 (owner ruling), so every turn now carries a number.
 * `undefined` below is therefore the helper's own tri-state, not a state the runner still reaches.
 */
describe("read withholds an image the request cannot carry", () => {
  test("the notice states the cause and asks for descriptions FIRST", () => {
    const notice = ReadTool.heldImageNotice("C:/glyphs/icon_004.png", 3)
    // Names the file, so the model can come back to exactly this one.
    expect(notice).toContain("icon_004.png")
    // States the cap as a number rather than "a limit", which a model cannot act on.
    expect(notice).toContain("only 3 images per request")
    // ⭐ The load-bearing half: describe BEFORE reading again. A notice that merely refuses would
    // leave the model holding three silent images and no reason to say anything about them.
    expect(notice).toContain("FIRST write down what each image you are holding shows")
    expect(notice).toContain("read this file again")
    // Says WHY it survives — the descriptions outlive the pixels. Without the reason this reads as
    // an arbitrary obstacle, and the model routes around obstacles.
    expect(notice).toContain("survive as your own text")
    // It must not read as a failure: nothing here says error, denied, or cannot.
    expect(notice.toLowerCase()).not.toContain("error")
    expect(notice.toLowerCase()).not.toContain("denied")
  })

  test("singular and plural both read correctly", () => {
    expect(ReadTool.heldImageNotice("a.png", 1)).toContain("only 1 image per request")
    expect(ReadTool.heldImageNotice("a.png", 2)).toContain("only 2 images per request")
  })

  test("the trigger is held >= limit, and an unknown cap never triggers", () => {
    // The arithmetic the runner applies, restated here so a change to it fails a test rather than a
    // production turn. `undefined` = the endpoint declared no cap = pass everything, which is the
    // same tri-state `budgetImages` and `VisionCopy` use.
    const withholds = (budget: { limit: number; held: number } | undefined) =>
      budget !== undefined && budget.held >= budget.limit
    expect(withholds(undefined)).toBe(false)
    expect(withholds({ limit: 3, held: 0 })).toBe(false)
    expect(withholds({ limit: 3, held: 2 })).toBe(false)
    // The third image is still handed over — the cap is what the REQUEST carries, so filling it
    // exactly is fine. It is the fourth that would evict one of them.
    expect(withholds({ limit: 3, held: 3 })).toBe(true)
    expect(withholds({ limit: 3, held: 9 })).toBe(true)
    expect(withholds({ limit: 1, held: 1 })).toBe(true)
  })
})
