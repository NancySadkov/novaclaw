import { describe, expect, test } from "bun:test"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * The harness drives a turn back to the rest of a set it enumerated itself.
 *
 * Two measured failures, one mechanism:
 *  · six glyphs, "please describe each glyph here" — the model opened ONE, described it, and stopped;
 *  · 400 icons, "describe the first 40" — it described ~23 and stopped mid-task, saying "I need to
 *    complete the remaining 18".
 * `shouldReground` catches neither: it needs 8 tool calls and exists for a LONG turn ending
 * over-confidently, where both of these are turns that quit.
 */

const coverage = (available: string[], opened: string[]) => ({ available, opened })
const SIX = ["icon_001.png", "icon_002.png", "icon_003.png", "icon_004.png", "icon_005.png", "icon_006.png"]

describe("asksForSet — read from the USER's words, never from the folder", () => {
  test("collection language counts", () => {
    expect(UnfinishedSet.asksForSet("please describe each glyph here")).toBe(true)
    expect(UnfinishedSet.asksForSet("Look at every png in this folder")).toBe(true)
    expect(UnfinishedSet.asksForSet("describe all the icons")).toBe(true)
    expect(UnfinishedSet.asksForSet("read them all")).toBe(true)
  })

  test("a question about ONE thing does not", () => {
    // ⚠️ The clause that keeps this from being a nuisance. A user asking about one picture in a
    // folder of six must never be told they missed five.
    expect(UnfinishedSet.asksForSet("what is in icon_004.png?")).toBe(false)
    expect(UnfinishedSet.asksForSet("describe this glyph")).toBe(false)
    expect(UnfinishedSet.asksForSet("what does the corset icon look like")).toBe(false)
  })
})

describe("untouched — compared by BASENAME", () => {
  test("a listing name matches a read's absolute path", () => {
    // The two sides come from different places: the harness lists bare names, the model writes
    // whatever path it likes. Comparing full strings would report every file as untouched.
    expect(
      UnfinishedSet.untouched(
        coverage(SIX, ["C:\\Users\\nangl\\d\\code\\test\\glyphs\\icon_001.png", "./icon_002.PNG"]),
      ),
    ).toEqual(["icon_003.png", "icon_004.png", "icon_005.png", "icon_006.png"])
  })

  test("nothing left when every file was opened", () => {
    expect(UnfinishedSet.untouched(coverage(SIX, SIX))).toEqual([])
  })
})

describe("shouldContinue — every clause is a case that must NOT fire", () => {
  test("the measured failure fires: asked for each, opened 1 of 6", () => {
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, ["icon_001.png"]), rounds: 0 })).toBe(
      true,
    )
  })

  test("a single-item request never fires, however many files exist", () => {
    expect(UnfinishedSet.shouldContinue({ asked: false, coverage: coverage(SIX, ["icon_001.png"]), rounds: 0 })).toBe(
      false,
    )
  })

  test("a turn that opened NOTHING is a different fault", () => {
    // It never started; that belongs to the tool-discovery nudges, not to "you are half done".
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, []), rounds: 0 })).toBe(false)
  })

  test("a finished turn does not fire", () => {
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, SIX), rounds: 0 })).toBe(false)
  })

  test("one file is not a set", () => {
    expect(
      UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(["only.png"], ["only.png"]), rounds: 0 }),
    ).toBe(false)
  })

  test("the round bound is exact, so a re-pricing is a visible decision", () => {
    // ⚠️ This is an AUTOMATIC drive — the user asked once and the harness keeps going — so it stops
    // at a stated ceiling rather than running while files remain.
    const partial = coverage(SIX, ["icon_001.png"])
    expect(
      UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: UnfinishedSet.MAX_STEER_ROUNDS - 1 }),
    ).toBe(true)
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: UnfinishedSet.MAX_STEER_ROUNDS })).toBe(
      false,
    )
  })
})

describe("continueMessage — one BATCH at a time", () => {
  test("names the batch, and forbids the two measured escapes", () => {
    const message = UnfinishedSet.continueMessage(["icon_002.png", "icon_003.png"], 1)
    expect(message).toContain("opened 1 file")
    expect(message).toContain("2 remain")
    expect(message).toContain("icon_002.png, icon_003.png")
    // ⭐ Told to continue, the model has previously INVENTED the files it had not opened (a crown, a
    // shield and a helmet for three glyphs that are none of those)…
    expect(message).toContain("Do not describe a file you have not opened")
    // …and it has stopped to ask which files were meant, with the names already on screen.
    expect(message).toContain("do not stop to ask which files")
  })

  test("399 remaining: ten names, not three hundred and ninety-nine", () => {
    // 🔴 The first version said "Open each remaining one" with 399 outstanding — an instruction that
    // cannot land. The second refused sets over 25, so it could not drive the owner's measured
    // 40-icon failure at all. A batch does both jobs.
    const many = Array.from({ length: 399 }, (_, i) => `icon_${i + 1}.png`)
    const message = UnfinishedSet.continueMessage(many, 1)
    expect(message).toContain("399 remain")
    expect(message).toContain(`Open these ${UnfinishedSet.STEER_BATCH} next`)
    expect(message).toContain("Then continue with the remaining 389")
    expect(message).not.toContain("icon_50.png")
  })

  test("the last batch does not promise more work", () => {
    expect(UnfinishedSet.continueMessage(["a.png", "b.png"], 4)).not.toContain("Then continue with the remaining")
  })
})
