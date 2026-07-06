import { describe, expect, test } from "bun:test"
import { homeSessionTimeLabel } from "./home-session-meta"

describe("homeSessionTimeLabel", () => {
  const noon = new Date("2026-07-06T12:00:00").getTime()

  test("same-day updates show a time", () => {
    const nine = new Date("2026-07-06T09:05:00").getTime()
    const label = homeSessionTimeLabel(nine, "en", noon)
    expect(label).toMatch(/9:05/)
  })

  test("yesterday within 24h still shows a time (day comes from the group header)", () => {
    const label = homeSessionTimeLabel(noon - 20 * 60 * 60 * 1000, "en", noon)
    expect(label).toMatch(/\d{1,2}:\d{2}/)
  })

  test("older updates show a short date", () => {
    const lastMonth = new Date("2026-06-01T15:30:00").getTime()
    const label = homeSessionTimeLabel(lastMonth, "en", noon)
    expect(label).toContain("Jun")
    expect(label).not.toMatch(/\d{1,2}:\d{2}/)
  })
})
