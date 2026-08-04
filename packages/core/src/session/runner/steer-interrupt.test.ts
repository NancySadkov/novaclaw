import { describe, expect, test } from "bun:test"
import { shouldCheckForSteer } from "./llm"

// The steer interrupt lets a mid-run prompt cut an in-flight generation instead of waiting out a long
// think (owner 2026-07-26: "reasoning and even the answer can be safely interrupted").
//
// The invariant that MUST hold: a tool is not interruptible. Tool calls settle inside the stream loop, so
// cutting after one has been emitted risks a half-written file or a half-sent message — real damage, unlike
// abandoning tokens. Once `sawToolCall` is set the answer is false forever after, whatever else is true.

const base = { sawToolCall: false, alreadyCut: false, now: 10_000, lastCheck: 0 }

describe("shouldCheckForSteer", () => {
  test("checks during plain generation once the throttle has elapsed", () => {
    expect(shouldCheckForSteer(base)).toBe(true)
  })

  test("NEVER checks once a tool call has been emitted this step", () => {
    expect(shouldCheckForSteer({ ...base, sawToolCall: true })).toBe(false)
    // …not even with an arbitrarily old last-check, which is the tempting way to regress this.
    expect(shouldCheckForSteer({ ...base, sawToolCall: true, now: 10_000_000, lastCheck: 0 })).toBe(false)
  })

  test("does not re-cut a stream it has already cut", () => {
    expect(shouldCheckForSteer({ ...base, alreadyCut: true })).toBe(false)
  })

  test("throttles: no DB hit on every streamed token", () => {
    expect(shouldCheckForSteer({ ...base, now: 100, lastCheck: 0 })).toBe(false)
    expect(shouldCheckForSteer({ ...base, now: 399, lastCheck: 0 })).toBe(false)
    expect(shouldCheckForSteer({ ...base, now: 400, lastCheck: 0 })).toBe(true)
  })
})
