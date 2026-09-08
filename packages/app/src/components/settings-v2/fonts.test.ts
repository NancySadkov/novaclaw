import { describe, expect, test } from "bun:test"
import { offeredFonts } from "./fonts"

describe("which fonts a picker offers", () => {
  const present = (family: string) => family === "Consolas" || family === "Menlo"

  test("everything we ship is offered without being measured", () => {
    // ⚠️ A bundled webfont measures as ABSENT until it loads — the app's own default mono font did,
    // in the running app. Subjecting shipped assets to the probe would report the default missing.
    const offered = offeredFonts({
      bundled: ["Inter", "JetBrainsMono Nerd Font Mono"],
      candidates: [],
      present: () => false,
      current: undefined,
    })
    expect(offered).toEqual(["Inter", "JetBrainsMono Nerd Font Mono"])
  })

  test("candidates are filtered to what this machine actually has", () => {
    const offered = offeredFonts({
      bundled: [],
      candidates: ["Consolas", "Fira Code", "Menlo"],
      present,
      current: undefined,
    })
    expect(offered).toEqual(["Consolas", "Menlo"])
  })

  /**
   * ⚠️ THE case. Someone who typed a font we do not list must not watch it disappear from its own
   * picker the next time they open Settings — that is the picker silently discarding their choice,
   * which is worse than the free-text box it replaced.
   */
  test("a value already set is always offered, even if unknown and unmeasurable", () => {
    const offered = offeredFonts({
      bundled: ["Inter"],
      candidates: ["Consolas"],
      present,
      current: "Comic Sans MS",
    })
    expect(offered).toContain("Comic Sans MS")
  })

  test("a current value that is already listed does not appear twice", () => {
    const offered = offeredFonts({ bundled: ["Inter"], candidates: [], present, current: "Inter" })
    expect(offered).toEqual(["Inter"])
  })

  test("blank and whitespace-only current values add nothing", () => {
    for (const current of [undefined, "", "   "]) {
      expect(offeredFonts({ bundled: ["Inter"], candidates: [], present, current })).toEqual(["Inter"])
    }
  })
})
