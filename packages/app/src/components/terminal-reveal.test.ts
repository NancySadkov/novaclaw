import { describe, expect, test } from "bun:test"
import { terminalRevealPosition } from "./terminal-reveal"

describe("terminalRevealPosition", () => {
  test("maps an old absolute buffer row to a scrolled viewport row", () => {
    // 120 buffer rows - 24 visible rows = 96 lines of scrollback. At the top limit, absolute row 5
    // is viewport row 5—not row 5 interpreted as five lines back from the bottom.
    expect(terminalRevealPosition(5, 120, 24)).toEqual({ viewportY: 96, viewportRow: 5 })
  })

  test("centers a history match when there is room on both sides", () => {
    expect(terminalRevealPosition(50, 120, 24)).toEqual({ viewportY: 58, viewportRow: 12 })
  })

  test("keeps a match on the live screen at the bottom viewport", () => {
    expect(terminalRevealPosition(110, 120, 24)).toEqual({ viewportY: 0, viewportRow: 14 })
  })

  test("clamps malformed coordinates instead of selecting outside the viewport", () => {
    expect(terminalRevealPosition(-5, 0, 0)).toEqual({ viewportY: 0, viewportRow: 0 })
  })
})
