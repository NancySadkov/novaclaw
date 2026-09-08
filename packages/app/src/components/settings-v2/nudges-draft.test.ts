import { describe, expect, test } from "bun:test"
import type { ConfigNudge } from "@novaclaw/core/config/nudge"
import { planNudgeSave } from "./nudges-draft"

const draft = (id = "one"): ConfigNudge.Info => ({
  id,
  name: "  Time safety  ",
  enabled: true,
  agents: ["writer"],
  hook: { type: "text-match", pattern: "Date\\(" },
  text: "  Check the transport shape.  ",
})

describe("planNudgeSave", () => {
  test("adds a trimmed nudge without changing its agent scope", () => {
    const result = planNudgeSave({ nudges: [], draft: draft() })
    expect(result).toEqual({
      ok: true,
      next: [{ ...draft(), name: "Time safety", text: "Check the transport shape." }],
    })
  })

  test("editing replaces by stable id and never duplicates the old row", () => {
    const result = planNudgeSave({ nudges: [draft()], editingID: "one", draft: { ...draft(), name: "New" } })
    expect(result.ok && result.next).toHaveLength(1)
  })

  test("rejects invalid regex and incomplete hook values", () => {
    expect(planNudgeSave({ nudges: [], draft: { ...draft(), hook: { type: "text-match", pattern: "[" } } })).toEqual({
      ok: false,
      reason: "pattern",
    })
    expect(planNudgeSave({ nudges: [], draft: { ...draft(), hook: { type: "tool-call", tool: "" } } })).toEqual({
      ok: false,
      reason: "hook",
    })
  })

  test("rejects time values outside the clock", () => {
    expect(
      planNudgeSave({
        nudges: [],
        draft: { ...draft(), hook: { type: "time-of-day", after: "25:00", before: "06:00" } },
      }),
    ).toEqual({ ok: false, reason: "hook" })
  })
})
