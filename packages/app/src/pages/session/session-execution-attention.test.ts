import { describe, expect, test } from "bun:test"
import { executionKeepsTurnOpen, visibleExecutionAttention } from "./session-execution-attention"

describe("execution recovery attention", () => {
  test("🔴 a stale interrupted attempt disappears while its replacement is working", () => {
    const interrupted = { state: "interrupted", attemptID: "old", failureClass: "interrupt" }
    expect(visibleExecutionAttention(interrupted, true)).toBeUndefined()
    expect(visibleExecutionAttention(interrupted, false)).toBe(interrupted)
  })

  test("paused and failed history cannot outrank live work", () => {
    expect(visibleExecutionAttention({ state: "paused" }, true)).toBeUndefined()
    expect(visibleExecutionAttention({ state: "failed" }, true)).toBeUndefined()
  })

  test("automatic recovery remains visible while it works", () => {
    const recovering = { state: "recovering" }
    expect(visibleExecutionAttention(recovering, true)).toBe(recovering)
  })

  test("ordinary busy and settled attempts never render as attention", () => {
    expect(visibleExecutionAttention({ state: "busy" }, false)).toBeUndefined()
    expect(visibleExecutionAttention({ state: "settled" }, false)).toBeUndefined()
  })

  test("every non-authoritative failure keeps the turn open across a restart", () => {
    for (const state of ["starting", "busy", "recovering", "paused", "failed", "interrupted"])
      expect(executionKeepsTurnOpen({ state, failureClass: "before-side-effect" }), state).toBe(true)
    expect(executionKeepsTurnOpen({ state: "interrupted", failureClass: "interrupt" })).toBe(false)
    expect(executionKeepsTurnOpen({ state: "settled" })).toBe(false)
  })
})
