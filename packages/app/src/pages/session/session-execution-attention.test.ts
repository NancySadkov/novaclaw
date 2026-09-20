import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { executionKeepsTurnOpen, visibleExecutionAttention } from "./session-execution-attention"

const pageSource = readFileSync(new URL("../session.tsx", import.meta.url), "utf8")

describe("execution recovery attention", () => {
  test("🔴 a stale interrupted attempt disappears while its replacement is working", () => {
    const interrupted = { state: "interrupted", attemptID: "old", failureClass: "interrupt" }
    expect(visibleExecutionAttention(interrupted, true)).toBeUndefined()
    expect(visibleExecutionAttention(interrupted, false)).toBeUndefined()
  })

  test("paused and failed history cannot outrank live work", () => {
    expect(visibleExecutionAttention({ state: "paused" }, true)).toBeUndefined()
    expect(visibleExecutionAttention({ state: "failed" }, true)).toBeUndefined()
  })

  test("automatic recovery remains visible while it works", () => {
    const recovering = { state: "recovering", failureClass: "before-side-effect" }
    expect(visibleExecutionAttention(recovering, true)).toBe(recovering)
  })

  test("an internal settlement handoff cannot masquerade as a failed-worker recovery", () => {
    expect(visibleExecutionAttention({ state: "recovering" }, true)).toBeUndefined()
    expect(visibleExecutionAttention({ state: "recovering" }, false)).toBeUndefined()
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

  test("session attention is constructed after the revert controller it reads", () => {
    const controller = pageSource.indexOf("const {\n    busy,")
    const attention = pageSource.indexOf("const executionAttention = createMemo")
    expect(controller).toBeGreaterThan(-1)
    expect(attention).toBeGreaterThan(controller)
  })

  test("an explicit stop is resumed by the empty composer instead of recovery chrome", () => {
    expect(pageSource).toContain("available: explicitlyStopped")
    expect(pageSource).toContain('run: () => executionAction("retry")')
  })
})
