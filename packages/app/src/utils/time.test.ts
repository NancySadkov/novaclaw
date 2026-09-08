import { describe, expect, test } from "bun:test"
import { getRelativeTime } from "./time"

const translate = (key: string, params?: Record<string, string | number>) =>
  `${key}${params?.count === undefined ? "" : `:${params.count}`}`

describe("relative time boundary", () => {
  test("normalizes decoded timestamps before doing arithmetic", () => {
    expect(getRelativeTime({ epochMillis: 1_000 }, translate, 66_000)).toBe("common.time.minutesAgo.short:1")
  })

  test("invalid instants stay absent and future clock skew is just now", () => {
    expect(getRelativeTime({}, translate, 66_000)).toBeUndefined()
    expect(getRelativeTime(67_000, translate, 66_000)).toBe("common.time.justNow")
  })
})
