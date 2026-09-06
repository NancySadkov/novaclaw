import { describe, expect, test } from "bun:test"
import { messageTime, resetMessageTimeFormatterCache } from "./message-time"

// A fixed instant so these assertions do not depend on when they run.
const NOON = Date.UTC(2026, 7, 23, 12, 0, 0) // 2026-08-23T12:00:00Z

describe("messageTime", () => {
  test("today shows the clock alone — the transcript row has no width to spare", () => {
    const out = messageTime({ created: Date.UTC(2026, 7, 23, 9, 5, 0), locale: "en-GB", now: NOON })!
    expect(out.label).not.toContain("Aug")
    expect(out.label).toMatch(/\d{1,2}[:.]\d{2}/)
  })

  test("another day adds the date, because the clock alone would be ambiguous", () => {
    const out = messageTime({ created: Date.UTC(2026, 7, 21, 9, 5, 0), locale: "en-GB", now: NOON })!
    expect(out.label).toContain("Aug")
    expect(out.label).toMatch(/\d{1,2}[:.]\d{2}/)
  })

  test("the FULL form is always complete, whatever the label chose", () => {
    const today = messageTime({ created: Date.UTC(2026, 7, 23, 9, 5, 0), locale: "en-GB", now: NOON })!
    const older = messageTime({ created: Date.UTC(2026, 7, 21, 9, 5, 0), locale: "en-GB", now: NOON })!
    for (const out of [today, older]) {
      expect(out.full).toContain("2026")
      expect(out.full).toContain("August")
    }
  })

  test("'today' is decided on the CALENDAR, not on a 24-hour window", () => {
    // 🔴 The falsifier for the cheap version. 23:50 "yesterday" is under 24 h before 09:00 today, so
    // a `now - t < 86_400_000` test would call it today and print a bare clock for a message from
    // another date. Compared as Y/M/D, it is correctly dated.
    const lateLastNight = Date.UTC(2026, 7, 22, 23, 50, 0)
    const morning = Date.UTC(2026, 7, 23, 9, 0, 0)
    expect(morning - lateLastNight).toBeLessThan(86_400_000)
    expect(messageTime({ created: lateLastNight, locale: "en-GB", now: morning })!.label).toContain("Aug")
  })

  test("a message we cannot date shows NO chip rather than a wrong one", () => {
    expect(messageTime({ created: undefined, locale: "en-GB", now: NOON })).toBeUndefined()
    expect(messageTime({ created: Number.NaN, locale: "en-GB", now: NOON })).toBeUndefined()
    expect(messageTime({ created: Number.POSITIVE_INFINITY, locale: "en-GB", now: NOON })).toBeUndefined()
  })

  test("epoch 0 is a real instant and is NOT dropped", () => {
    // ⚠️ The reason the guard tests `=== undefined` rather than falsiness.
    expect(messageTime({ created: 0, locale: "en-GB", now: NOON })).toBeDefined()
  })

  test("decoded and ISO transport shapes format identically", () => {
    const millis = Date.UTC(2026, 7, 23, 9, 5, 0)
    const expected = messageTime({ created: millis, locale: "en-GB", now: NOON })
    expect(messageTime({ created: { epochMillis: millis }, locale: "en-GB", now: NOON })).toEqual(expected)
    expect(messageTime({ created: new Date(millis).toISOString(), locale: "en-GB", now: NOON })).toEqual(expected)
    expect(expected?.iso).toBe("2026-08-23T09:05:00.000Z")
  })

  test("the locale is honoured", () => {
    const de = messageTime({ created: Date.UTC(2026, 7, 21, 9, 5, 0), locale: "de-DE", now: NOON })!
    expect(de.full).toContain("August")
    expect(de.full).toContain("2026")
    // A locale with a different month abbreviation proves the formatter is not hardcoded to en.
    const ja = messageTime({ created: Date.UTC(2026, 7, 21, 9, 5, 0), locale: "ja-JP", now: NOON })!
    expect(ja.label).not.toBe(de.label)
  })

  test("reuses the four formatter instances for every row in one locale", () => {
    const Original = Intl.DateTimeFormat
    let constructions = 0
    function Wrapped(this: unknown, ...args: any[]) {
      constructions++
      return new Original(...args)
    }
    resetMessageTimeFormatterCache()
    Intl.DateTimeFormat = Wrapped as unknown as typeof Intl.DateTimeFormat
    try {
      messageTime({ created: NOON, locale: "en-GB", now: NOON })
      messageTime({ created: NOON + 1_000, locale: "en-GB", now: NOON })
      expect(constructions).toBe(4)
    } finally {
      Intl.DateTimeFormat = Original
      resetMessageTimeFormatterCache()
    }
  })
})
