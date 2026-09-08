import { describe, expect, test } from "bun:test"
import { calendarDay } from "./calendar-day"
import { parseSettingsNumber } from "../components/settings-v2/parts/number-field"

describe("calendarDay", () => {
  test.each(["", "0", "32", "1.5", "nope"])("refuses %p rather than coercing it", (raw) => {
    expect(() => calendarDay(raw)).toThrow("Choose a whole day from 1 to 31")
  })

  test.each([
    ["1", 1],
    ["31", 31],
  ])("accepts boundary %p", (raw, expected) => {
    expect(calendarDay(raw as string)).toBe(expected)
  })
})

describe("parseSettingsNumber decimal contract", () => {
  test.each(["0", "61", "nope"])("refuses %p outside 0.5..60", (raw) => {
    expect(parseSettingsNumber(raw, { min: 0.5, max: 60, allowDecimal: true })).toBeUndefined()
  })
  test("accepts the displayed half-minute value", () => {
    expect(parseSettingsNumber("0.5", { min: 0.5, max: 60, allowDecimal: true })).toBe(0.5)
  })
})
