import { describe, expect, test } from "bun:test"
import { MINUTE_MS, SECOND_MS, fromMs, toMs } from "./units"

describe("showing a stored millisecond value in human units", () => {
  test("the audit's own example stops being a row of zeros", () => {
    expect(fromMs(300_000, MINUTE_MS)).toBe("5")
    expect(fromMs(4_000, SECOND_MS)).toBe("4")
  })

  /**
   * ⚠️ THE property this module exists for. A stored 90 000 ms is 1.5 minutes. Rounding it to "2"
   * for display would save 120 000 the next time that row is edited for any unrelated reason — a
   * settings screen quietly changing a setting it was only meant to be showing.
   */
  test("a value that is not a whole unit keeps its fraction", () => {
    expect(fromMs(90_000, MINUTE_MS)).toBe("1.5")
    expect(fromMs(4_500, SECOND_MS)).toBe("4.5")
    expect(toMs(fromMs(90_000, MINUTE_MS), MINUTE_MS)).toBe(90_000)
  })

  test("unset stays unset rather than becoming a zero", () => {
    // An empty box means "use the default". Rendering "0" would claim the user chose no timeout.
    expect(fromMs(undefined, MINUTE_MS)).toBe("")
    expect(fromMs(0, MINUTE_MS)).toBe("")
    expect(toMs("", MINUTE_MS)).toBeUndefined()
    expect(toMs("0", MINUTE_MS)).toBeUndefined()
    expect(toMs("-3", MINUTE_MS)).toBeUndefined()
    expect(toMs("nonsense", MINUTE_MS)).toBeUndefined()
  })

  test("float noise never reaches the box", () => {
    // 0.1 + 0.2 arithmetic shows up immediately once a unit divides unevenly.
    expect(fromMs(100, SECOND_MS)).toBe("0.1")
    expect(fromMs(1, MINUTE_MS)).not.toContain("e")
  })

  test("round trips are stable for the values people actually type", () => {
    for (const minutes of [1, 2.5, 5, 15, 30]) {
      expect(fromMs(toMs(String(minutes), MINUTE_MS), MINUTE_MS)).toBe(String(minutes))
    }
  })
})
