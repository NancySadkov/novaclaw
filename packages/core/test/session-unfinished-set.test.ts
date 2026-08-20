import { describe, expect, test } from "bun:test"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * The harness steers a turn back to the rest of a set it enumerated itself.
 *
 * Measured 2026-08-20: asked "please describe each glyph here", the model opened ONE of six images,
 * described it correctly, and stopped. `shouldReground` could not catch it — that backstop needs 8
 * tool calls and exists for a long turn ending over-confidently, where this is a turn that quits.
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
    const remaining = UnfinishedSet.untouched(
      coverage(SIX, ["C:\\Users\\nangl\\d\\code\\test\\glyphs\\icon_001.png", "./icon_002.PNG"]),
    )
    expect(remaining).toEqual(["icon_003.png", "icon_004.png", "icon_005.png", "icon_006.png"])
  })

  test("nothing left when every file was opened", () => {
    expect(UnfinishedSet.untouched(coverage(SIX, SIX))).toEqual([])
  })
})

describe("shouldContinue — every clause is a case that must NOT fire", () => {
  test("the measured failure fires: asked for each, opened 1 of 6", () => {
    expect(
      UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, ["icon_001.png"]), alreadyNudged: false }),
    ).toBe(true)
  })

  test("a single-item request never fires, however many files exist", () => {
    expect(
      UnfinishedSet.shouldContinue({ asked: false, coverage: coverage(SIX, ["icon_001.png"]), alreadyNudged: false }),
    ).toBe(false)
  })

  test("a turn that opened NOTHING is a different fault", () => {
    // It never started; that belongs to the tool-discovery nudges, not to "you are half done".
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, []), alreadyNudged: false })).toBe(false)
  })

  test("a finished turn does not fire", () => {
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, SIX), alreadyNudged: false })).toBe(false)
  })

  test("one file is not a set", () => {
    expect(
      UnfinishedSet.shouldContinue({
        asked: true,
        coverage: coverage(["only.png"], ["only.png"]),
        alreadyNudged: false,
      }),
    ).toBe(false)
  })

  test("it fires at most ONCE — a nudge that repeats is a loop", () => {
    expect(
      UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, ["icon_001.png"]), alreadyNudged: true }),
    ).toBe(false)
  })
})

describe("continueMessage", () => {
  test("names the files, and forbids describing what was not opened", () => {
    const message = UnfinishedSet.continueMessage(["icon_002.png", "icon_003.png"], 1)
    expect(message).toContain("opened 1 file")
    expect(message).toContain("covers 3")
    expect(message).toContain("icon_002.png, icon_003.png")
    // ⭐ The clause that answers the OTHER failure mode this programme measured: told to continue,
    // the model has previously invented the files it had not opened (a crown, a shield, a helmet).
    expect(message).toContain("Do not describe a file you have not opened")
  })

  test("a long remainder is truncated and SAYS so", () => {
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.png`)
    const message = UnfinishedSet.continueMessage(many, 1)
    expect(message).toContain("and 8 more")
    expect(message).not.toContain("f19.png")
  })
})

describe("scale — a set too large to finish", () => {
  test("400 files: the steer stays SILENT rather than commanding 399 reads", () => {
    // 🔴 The first version fired here and said "Open each remaining one" with 399 outstanding —
    // ~400 sequential model turns, off a nudge the user never asked for. Measured against the
    // owner's own 400-icon folder on 2026-08-20.
    const available = Array.from({ length: 400 }, (_, i) => `icon_${i}.png`)
    expect(
      UnfinishedSet.shouldContinue({
        asked: true,
        coverage: { available, opened: ["icon_0.png"] },
        alreadyNudged: false,
      }),
    ).toBe(false)
  })

  test("the boundary is exact, so a re-pricing is a visible decision", () => {
    const set = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.png`)
    const fires = (n: number) =>
      UnfinishedSet.shouldContinue({
        asked: true,
        coverage: { available: set(n), opened: ["f0.png"] },
        alreadyNudged: false,
      })
    expect(fires(UnfinishedSet.MAX_STEERABLE_SET)).toBe(true)
    expect(fires(UnfinishedSet.MAX_STEERABLE_SET + 1)).toBe(false)
  })
})
