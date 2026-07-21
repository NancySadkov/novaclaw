import { describe, expect, test } from "bun:test"
import { normalizeSessionTimes, sessionTimeMillis } from "./session-time"

// Store-boundary contract (owner-hit 2026-07-21): live-event session records carry ISO-string
// times (the SSE mirrors Type-side payloads) while REST serves epoch millis; DateTime.fromMillis
// threw on the strings and faulted the whole Chats pane. Folds normalize through here.

describe("normalizeSessionTimes", () => {
  test("coerces ISO-string times to epoch millis", () => {
    const iso = "2026-07-21T21:19:58.352Z"
    const input: { id: string; time: { created?: unknown; updated?: unknown } } = {
      id: "ses_x",
      time: { created: iso, updated: iso },
    }
    const normalized = normalizeSessionTimes(input)
    expect(normalized.time.created).toBe(Date.parse(iso))
    expect(normalized.time.updated).toBe(Date.parse(iso))
  })

  test("returns the SAME reference for already-conformant records (reconcile stability)", () => {
    const info = { id: "ses_x", time: { created: 1784662154383, updated: 1784662154383 } }
    expect(normalizeSessionTimes(info)).toBe(info)
  })

  test("handles archived and mixed encodings", () => {
    const input: { time: { created?: unknown; updated?: unknown; archived?: unknown } } = {
      time: { created: 1784662154383, updated: "2026-07-21T21:19:58.352Z", archived: "2026-07-21T22:00:00.000Z" },
    }
    const normalized = normalizeSessionTimes(input)
    expect(normalized.time.created).toBe(1784662154383)
    expect(normalized.time.updated).toBe(Date.parse("2026-07-21T21:19:58.352Z"))
    expect(normalized.time.archived).toBe(Date.parse("2026-07-21T22:00:00.000Z"))
  })

  test("tolerates records without time", () => {
    const info = { id: "ses_x", time: undefined }
    expect(normalizeSessionTimes(info)).toBe(info)
  })
})

describe("sessionTimeMillis", () => {
  test("passes numbers through and parses ISO strings", () => {
    expect(sessionTimeMillis(1784662154383)).toBe(1784662154383)
    expect(sessionTimeMillis("2026-07-21T21:19:58.352Z")).toBe(Date.parse("2026-07-21T21:19:58.352Z"))
  })

  test("degrades garbage to 0 instead of NaN-poisoning sorts", () => {
    expect(sessionTimeMillis("not a date")).toBe(0)
  })
})
