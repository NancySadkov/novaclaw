import { describe, expect, test } from "bun:test"
import { elapsedMillis, toDate, toEpochMillis, toISOString } from "./time"

const AT = 1_700_000_000_000
const ISO = "2023-11-14T22:13:20.000Z"

describe("Timestamp boundary", () => {
  test("normalizes every timestamp shape used across schema and transport boundaries", () => {
    for (const value of [AT, ISO, new Date(AT), { epochMillis: AT }]) expect(toEpochMillis(value)).toBe(AT)
  })

  test("rejects malformed and non-finite values instead of exporting NaN", () => {
    for (const value of [undefined, null, "", "nonsense", Number.NaN, Infinity, {}, { epochMillis: NaN }])
      expect(toEpochMillis(value)).toBeUndefined()
  })

  test("owns Date and ISO construction", () => {
    expect(toDate({ epochMillis: AT })?.getTime()).toBe(AT)
    expect(toISOString({ epochMillis: AT })).toBe(ISO)
  })

  test("does arithmetic only after both operands normalize", () => {
    expect(elapsedMillis({ epochMillis: 1_000 }, "1970-01-01T00:00:08.900Z")).toBe(7_900)
    expect(elapsedMillis({}, AT)).toBeUndefined()
  })
})
