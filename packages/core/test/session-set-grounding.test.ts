import { describe, expect, test } from "bun:test"
import { UnfinishedSet } from "@novaclaw/core/session/runner/unfinished-set"

/**
 * A description of a file that was never opened.
 *
 * 🔴 Measured 2026-08-20, run 10. Denied `spawn`, the model globbed the folder and emitted a table:
 *
 *     icon_101_r06_c01.png | Icon 101 at grid position (6, 1)
 *     icon_103_r06_c03.png | Icon 103
 *
 * **20 files opened, 351 "described", 331 never looked at.** Every one of those lines is the filename
 * restated as a grid coordinate — no icon content whatsoever — and they pass any check that asks
 * merely whether the file was mentioned. Run 8, which opened 100, described exactly those 100 and
 * invented nothing, so this is not noise: it is what the model does when finishing honestly looks
 * expensive.
 *
 * The harness already tells it "Do not describe a file you have not opened" and already knows which
 * files were opened. It never compared the two.
 *
 * ⚠️ The false-positive cases come first and outnumber the true ones. A model legitimately names a
 * file it is about to open, one it failed to open, and files inside plans and headings — none of
 * those are claims about a picture, and a check that nags on them would be worse than the bug.
 */

const opened = ["icon_001_r01_c01.png", "icon_002_r01_c02.png"]

describe("it must NOT fire on an honest line", () => {
  test("a file that WAS opened, however it is written", () => {
    // Paths come back absolute, relative, and with either separator — compared by leaf, like coverage.
    const text = [
      "C:\\glyphs\\icon_001_r01_c01.png shows a broken heart split down the middle.",
      "./icon_002_r01_c02.png — a pair of dice showing five and three.",
    ].join("\n")
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual([])
  })

  test("announcing the next file is not describing it", () => {
    // ⭐ The load-bearing exclusion: this is what a model does on every healthy turn.
    const text = "Next I will open icon_003_r01_c03.png and say what it contains.\nLet me read icon_004_r01_c04.png now."
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual([])
  })

  test("reporting a FAILED read is honest, not invention", () => {
    const text =
      "icon_400_r20_c17.png does not exist, so I could not open it.\n" +
      "icon_399_r20_c19.png — unable to read, permission denied."
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual([])
  })

  test("a bare filename with nothing after it is a heading or a list", () => {
    const text = "Remaining:\nicon_005_r01_c05.png\nicon_006_r01_c06.png\nicon_007_r01_c07.png:"
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual([])
  })
})

describe("it MUST fire on the measured fabrication", () => {
  test("the verbatim shape from run 10 — a filename restated as a grid position", () => {
    const text = [
      "icon_101_r06_c01.png | Icon 101 at grid position (6, 1)",
      "icon_105_r06_c05.png | Icon 105 at grid position (6, 5)",
    ].join("\n")
    expect([...UnfinishedSet.describedWithoutOpening(opened, text)].sort()).toEqual([
      "icon_101_r06_c01.png",
      "icon_105_r06_c05.png",
    ])
  })

  test("a plausible INVENTED description counts too — content is not the test, opening is", () => {
    // 🔴 The dangerous case. "A golden crown" is exactly what a confabulated line looks like, and it
    // is indistinguishable from a real one by reading. Only the read record separates them.
    const text = "icon_050_r03_c10.png: a golden crown with three points and a red gem at the centre."
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual(["icon_050_r03_c10.png"])
  })

  test("a mixed answer reports only the ungrounded half", () => {
    const text = [
      "icon_001_r01_c01.png: a broken heart.",
      "icon_060_r03_c20.png: a silver shield with a lion.",
    ].join("\n")
    expect(UnfinishedSet.describedWithoutOpening(opened, text)).toEqual(["icon_060_r03_c20.png"])
  })
})

describe("the correction names the files", () => {
  test("it says how many, names a batch, and forbids the exact dodge that was measured", () => {
    const message = UnfinishedSet.groundingMessage(["icon_101_r06_c01.png", "icon_105_r06_c05.png"])
    expect(message).toContain("2 files you never opened")
    expect(message).toContain("icon_101_r06_c01.png")
    // ⭐ Naming the dodge matters: the model's output WAS the filename and its grid position, so
    // "describe them properly" without this invites the same table again.
    expect(message).toContain("Do not restate the filename or its grid position as a description")
    expect(message).toContain("A filename is not a picture")
  })

  test("a huge fabrication names a batch, not all 331", () => {
    const many = Array.from({ length: 331 }, (_, i) => `icon_${i + 1}.png`)
    const message = UnfinishedSet.groundingMessage(many)
    expect(message).toContain("331 files you never opened")
    expect(message).not.toContain("icon_300.png")
  })
})
