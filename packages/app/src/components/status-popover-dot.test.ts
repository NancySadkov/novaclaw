import { describe, expect, test } from "bun:test"
import { STATUS_DOT_CLASS, statusDotTone, type StatusDotTone } from "./status-popover-dot"

describe("server health dot: three states, three answers", () => {
  test("a healthy server is healthy and not also unreachable", () => {
    const tone = statusDotTone({ serverHealth: true })
    expect(tone).toBe("healthy")
    expect(tone).not.toBe("unreachable")
  })

  test("an unreachable server is visibly unreachable, not blank", () => {
    const tone = statusDotTone({ serverHealth: false })
    expect(tone).toBe("unreachable")
    expect(tone).not.toBe("unknown")
    expect(STATUS_DOT_CLASS[tone]).toBeTruthy()
  })

  test("not yet heard from is its own answer", () => {
    expect(statusDotTone({ serverHealth: undefined })).toBe("unknown")
  })

  test("every server state gets one distinct visible class", () => {
    const tones = new Set<StatusDotTone>()
    for (const serverHealth of [true, false, undefined] as const) tones.add(statusDotTone({ serverHealth }))
    expect(tones).toEqual(new Set<StatusDotTone>(["healthy", "unreachable", "unknown"]))

    const classes = Object.values(STATUS_DOT_CLASS)
    expect(classes.every((value) => value.length > 0)).toBe(true)
    expect(new Set(classes).size).toBe(classes.length)
  })
})
