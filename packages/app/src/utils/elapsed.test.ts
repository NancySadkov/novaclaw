import { describe, expect, test } from "bun:test"
import { formatElapsed } from "./elapsed"

describe("formatElapsed", () => {
  test("seconds only under a minute", () => {
    expect(formatElapsed(0, 3_400)).toBe("3s")
  })

  test("minutes and seconds under an hour", () => {
    expect(formatElapsed(0, 192_000)).toBe("3m 12s")
  })

  test("hours drop the seconds because the minute is the whole story", () => {
    expect(formatElapsed(0, 3 * 3_600_000 + 7 * 60_000 + 59_000)).toBe("3h 7m")
  })

  test("a clock that steps backwards clamps to zero rather than going negative", () => {
    expect(formatElapsed(10_000, 1_000)).toBe("0s")
  })
})
