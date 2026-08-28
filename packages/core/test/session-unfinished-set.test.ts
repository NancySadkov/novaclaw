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

  test("a WORD, never a substring — the 835k-token lesson", () => {
    // 🔴 Measured on the owner's instance 2026-08-21. The cue `"all "` was tested with `includes`,
    // so it matched the middle of "C-all the", and a probe whose whole prompt was
    // `Call the colleague tool with op "list"…` was read as a request to describe a folder. The
    // steer then drove that session through twenty unrelated repository files — 835,145 input
    // tokens — because `continueMessage` names files and says "do not stop to ask", which reads as
    // the user's own instruction rather than a suggestion the model may decline.
    expect(UnfinishedSet.asksForSet('Call the colleague tool with op "list"')).toBe(false)
    expect(UnfinishedSet.asksForSet("Install the dependencies and run the build")).toBe(false)
    expect(UnfinishedSet.asksForSet("Recall the decision we made about naming")).toBe(false)
    expect(UnfinishedSet.asksForSet("please call the API and show me the response")).toBe(false)
    // …while the words themselves still count, including as a whole message.
    expect(UnfinishedSet.asksForSet("open all")).toBe(true)
    expect(UnfinishedSet.asksForSet("describe all of them")).toBe(true)
    // A cue must not swallow a longer word that merely contains it: "reach", "beach", "overall".
    expect(UnfinishedSet.asksForSet("reach the server")).toBe(false)
    expect(UnfinishedSet.asksForSet("what is the overall shape")).toBe(false)
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

  test("a turn that opened NOTHING now FIRES — it is the case that most needs steering", () => {
    // 🔴 Reversed 2026-08-20. This used to expect `false`, reasoning that a turn which never started
    // belonged to the tool-discovery nudges rather than to "you are half done". Measured twice that
    // day: asked for 400 icons, the model ran `glob` and `bash ls`, listed the folder, and finished
    // with ZERO reads. It had found its tools — it simply never opened one — and nothing else in the
    // harness reacted. The run produced nothing at all.
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: coverage(SIX, []), rounds: 0 })).toBe(true)
    // ⚠️ What keeps this from nagging a model that genuinely cannot start: three barren rounds stop
    // it. The old clause ASSUMED that case; this one detects it.
    expect(
      UnfinishedSet.shouldContinue({
        asked: true,
        coverage: coverage(SIX, []),
        rounds: 3,
        barren: UnfinishedSet.MAX_BARREN_ROUNDS,
      }),
    ).toBe(false)
  })

  test('the zero case gets its own sentence, not "you have opened 0 files"', () => {
    // "You have opened 0 files" invites an argument about whether it was supposed to. Naming the
    // listing it just made, and the files to open, does not.
    const message = UnfinishedSet.continueMessage(SIX, 0)
    expect(message).toContain("listed the files but have not opened any")
    expect(message).toContain("a listing never shows what a picture contains")
    expect(message).not.toContain("opened 0 file")
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
    expect(
      UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: UnfinishedSet.MAX_STEER_ROUNDS }),
    ).toBe(false)
  })
})

describe("the bound scales with the work, and stops when steering stops working", () => {
  const many = Array.from({ length: 400 }, (_, i) => `icon_${i + 1}.png`)
  const partial = { available: many, opened: many.slice(0, 44) }

  test("a 400-file set is not stopped at the small-set ceiling", () => {
    // 🔴 The measured failure. The image floor is 1, so a turn ends after one picture and a round
    // yields about one file — a flat 40 rounds finishes a tenth of a 400-file request. Round 40 used
    // to be the end; it must now be the middle.
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: 40 })).toBe(true)
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: 399 })).toBe(true)
  })

  test("but it is still BOUNDED — an automatic drive never runs unbounded", () => {
    // The reason the old ceiling existed is unchanged: the user asked once, and everything after the
    // first steer is the harness deciding to continue. Proportional is not the same as infinite.
    const ceiling = UnfinishedSet.roundCeiling(many.length)
    expect(ceiling).toBe(800)
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: ceiling })).toBe(false)
  })

  test("a small set keeps exactly the old ceiling, so nothing about six glyphs changes", () => {
    expect(UnfinishedSet.roundCeiling(6)).toBe(UnfinishedSet.MAX_STEER_ROUNDS)
    expect(UnfinishedSet.roundCeiling(1)).toBe(UnfinishedSet.MAX_STEER_ROUNDS)
  })

  test("three barren rounds stop the drive however much work remains", () => {
    // ⭐ The real safety, and why the ceiling can afford to scale. A count ceiling cannot tell a
    // stuck model from a busy one and stops both at the same arbitrary number; this stops the stuck
    // one in three rounds and never touches the busy one.
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: 5, barren: 2 })).toBe(true)
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: 5, barren: 3 })).toBe(false)
  })

  test("barren defaults to zero, so an omitted count never silently stops the drive", () => {
    // ⚠️ A caller that has not been updated must fail OPEN — dropping the field must not read as
    // "barren", which would stop every drive on its first round.
    expect(UnfinishedSet.shouldContinue({ asked: true, coverage: partial, rounds: 5 })).toBe(true)
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

describe("requestedLimit — the set the USER asked for, not what is on disk", () => {
  test("an explicit count is read", () => {
    // 🔴 Measured: "the first 100 png files" in a folder of 400 drove toward 200 names. A harness
    // that keeps working after the job is done is as wrong as one that stops early.
    expect(UnfinishedSet.requestedLimit("Describe each of the first 100 png files in this folder")).toBe(100)
    expect(UnfinishedSet.requestedLimit("describe the first 40 png files, in filename order")).toBe(40)
    expect(UnfinishedSet.requestedLimit("describe 10 images from here")).toBe(10)
    expect(UnfinishedSet.requestedLimit("top 12 icons please")).toBe(12)
  })

  test("no count means the whole set — the previous behaviour exactly", () => {
    expect(UnfinishedSet.requestedLimit("please describe each glyph here")).toBeUndefined()
    expect(UnfinishedSet.requestedLimit("describe all the icons")).toBeUndefined()
    // ⚠️ A number that is not a COUNT of the things asked for must not be read as one.
    expect(UnfinishedSet.requestedLimit("describe icon_004_r01_c04.png")).toBeUndefined()
    expect(UnfinishedSet.requestedLimit("what is in the 256 folder?")).toBeUndefined()
  })
})
