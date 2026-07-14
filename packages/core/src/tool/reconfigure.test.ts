import { describe, expect, test } from "bun:test"
import { diffSummary } from "./reconfigure"

// Pure summary tests — the tool's write path is the shared PromptOverrideSwitched event +
// projector (covered by the switch-op family); permission gating is the shared Tool.withPermission
// machinery. What is OURS here is the revert breadcrumb the model reads back.

describe("reconfigure diffSummary", () => {
  test("identical text reports unchanged (no event should be published)", () => {
    const summary = diffSummary("keep calm", "keep calm")
    expect(summary.changed).toBe(false)
    expect(summary.previousLength).toBe(9)
    expect(summary.nextLength).toBe(9)
  })

  test("clearing reports cleared with the previous length", () => {
    const summary = diffSummary("old rules\nline two", null)
    expect(summary.changed).toBe(true)
    expect(summary.previousLength).toBe(18)
    expect(summary.nextLength).toBe(0)
    expect(summary.message).toContain("cleared")
    expect(summary.message).toContain("18 -> 0")
  })

  test("clearing an already-empty override is a no-op", () => {
    expect(diffSummary("", null).changed).toBe(false)
  })

  test("replacement names the first differing line (the revert breadcrumb)", () => {
    const summary = diffSummary("alpha\nbeta\ngamma", "alpha\nBETA\ngamma")
    expect(summary.changed).toBe(true)
    expect(summary.message).toContain("line 2")
    expect(summary.message).toContain('"beta"')
    expect(summary.message).toContain('"BETA"')
    expect(summary.message).toContain("revert")
  })

  test("an added trailing line diffs against <none>", () => {
    const summary = diffSummary("alpha", "alpha\nnew rule")
    expect(summary.message).toContain("line 2")
    expect(summary.message).toContain("<none>")
    expect(summary.message).toContain('"new rule"')
  })

  test("long lines are clipped in the breadcrumb", () => {
    const long = "x".repeat(200)
    const summary = diffSummary("short", long)
    expect(summary.message).toContain("...")
    expect(summary.message.length).toBeLessThan(400)
  })
})
