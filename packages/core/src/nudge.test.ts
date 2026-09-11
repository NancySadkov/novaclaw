import { describe, expect, test } from "bun:test"
import type { ConfigNudge } from "./config/nudge"
import { Nudge } from "./nudge"

const definition = (hook: ConfigNudge.Hook): ConfigNudge.Info => ({
  id: "test",
  name: "Test",
  enabled: true,
  hook,
  text: "Check this.",
})

describe("Nudge", () => {
  test("ships resource, JavaScript time, and new-day guards enabled", () => {
    expect(Nudge.defaults().map((item) => [item.id, item.enabled])).toEqual([
      [Nudge.LOW_RESOURCE_ID, true],
      [Nudge.JAVASCRIPT_TIME_ID, true],
      [Nudge.NEW_DAY_ID, true],
    ])
  })

  test("the time-safety example catches direct timestamp arithmetic and Date construction", () => {
    const item = Nudge.defaults().find((entry) => entry.id === Nudge.JAVASCRIPT_TIME_ID)!
    expect(
      Nudge.matches(item, { type: "tool", id: "a", name: "write", input: { content: "done - message.time.created" } }),
    ).toBe(true)
    expect(
      Nudge.matches(item, { type: "tool", id: "b", name: "write", input: { content: "new Date(event.timestamp)" } }),
    ).toBe(true)
    expect(
      Nudge.matches(item, { type: "tool", id: "c", name: "write", input: { content: "const label = title.trim()" } }),
    ).toBe(false)
  })

  test("invalid regex is inert rather than crashing a turn", () => {
    expect(
      Nudge.matches(definition({ type: "text-match", pattern: "[" }), {
        type: "tool",
        id: "a",
        name: "write",
        input: "anything",
      }),
    ).toBe(false)
  })

  test("matches MCP prefixes, file operation+extension, compaction, and pressure", () => {
    expect(
      Nudge.matches(definition({ type: "mcp-call", server: "github" }), {
        type: "tool",
        id: "1",
        name: "github_create_issue",
        input: {},
      }),
    ).toBe(true)
    expect(
      Nudge.matches(definition({ type: "file-read", extension: ".ts" }), {
        type: "tool",
        id: "2",
        name: "read",
        input: { path: "src/a.ts" },
      }),
    ).toBe(true)
    expect(
      Nudge.matches(definition({ type: "file-write", extension: "ts" }), {
        type: "tool",
        id: "3",
        name: "read",
        input: { path: "src/a.ts" },
      }),
    ).toBe(false)
    expect(
      Nudge.matches(definition({ type: "file-write", extension: "tsx" }), {
        type: "tool",
        id: "4",
        name: "apply_patch",
        input: { patchText: "*** Begin Patch\n*** Update File: src/a.tsx\n@@\n-old\n+new\n*** End Patch" },
      }),
    ).toBe(true)
    expect(Nudge.matches(definition({ type: "after-compaction" }), { type: "compaction", id: "cmp" })).toBe(true)
    expect(
      Nudge.matches(definition({ type: "resource-pressure", level: "floor" }), {
        type: "resource",
        level: "warning",
        bucket: "h",
      }),
    ).toBe(false)
  })

  test("time windows support ordinary and overnight ranges with one daily occurrence", () => {
    const night = definition({ type: "time-of-day", after: "18:00", before: "06:00" })
    expect(Nudge.matches(night, { type: "clock", at: new Date(2026, 8, 8, 23, 0) })).toBe(true)
    expect(Nudge.matches(night, { type: "clock", at: new Date(2026, 8, 8, 12, 0) })).toBe(false)
    expect(Nudge.occurrence({ type: "clock", at: new Date(2026, 8, 8, 23, 0) })).toBe("clock:2026-09-08")
  })

  test("stored empty list intentionally disables every shipped default", () => {
    expect(Nudge.resolved(undefined)).toHaveLength(3)
    expect(Nudge.resolved([])).toEqual([])
  })
})

/**
 * 🔴 **THE QUIET RULE** — see `Nudge.deliverable` for the reasoning. The owner's report was a nudge
 * that fired on every edit touching a timestamp; these are the four answers the rule has to get
 * right, and each one fails differently if the two caps collapse into one.
 */
describe("the quiet rule", () => {
  const MINUTE = 60_000
  const NOW = 1_789_000_000_000
  const caseOf = (
    over: Partial<{
      occurrence: string
      firedAt: number
      spammable: boolean
      now: number
      compactedAfter: boolean
    }> = {},
  ) => ({
    prior: { occurrence: "tool:call-1", firedAt: over.firedAt ?? NOW - 31 * MINUTE },
    occurrence: over.occurrence ?? "tool:call-2",
    spammable: over.spammable ?? false,
    now: over.now ?? NOW,
    compactedAfter: over.compactedAfter ?? false,
  })

  test("a trigger that fires on every edit delivers once, not on every edit", () => {
    // Same context, five minutes in: the interval floor holds it back.
    expect(Nudge.deliverable(caseOf({ firedAt: NOW - 5 * MINUTE }))).toBe(false)
    // The floor has passed and the context still has not turned over: still quiet. This is the case
    // the shipped time-safety nudge used to fail a thousand times a day.
    expect(Nudge.deliverable(caseOf())).toBe(false)
  })

  test("a compaction re-arms it, because that is where the reminder gets summarised away", () => {
    expect(Nudge.deliverable(caseOf({ compactedAfter: true }))).toBe(true)
    // …but compaction alone does not lift the floor: two compactions forty seconds apart owe the
    // model one reminder, not two.
    expect(Nudge.deliverable(caseOf({ compactedAfter: true, firedAt: NOW - 40_000 }))).toBe(false)
  })

  test("spammable is the opt-out, and it is total — except against a replay", () => {
    expect(Nudge.deliverable(caseOf({ spammable: true, firedAt: NOW - 1_000 }))).toBe(true)
    // The heartbeat the owner named fires every 30 minutes with a changing count; a re-delivery of
    // the SAME occurrence is still a duplicate of one message, not a new beat.
    expect(Nudge.deliverable(caseOf({ spammable: true, occurrence: "tool:call-1" }))).toBe(false)
  })

  test("a nudge whose occurrence IS a period does not wait for a compaction", () => {
    // The new-day notice has to survive a night in which nothing compacts, or the Prompt Hygiene
    // invariant quietly loses its handler.
    expect(Nudge.deliverable(caseOf({ occurrence: "clock:2026-09-12" }))).toBe(true)
    expect(Nudge.deliverable(caseOf({ occurrence: "resource:warning:memory" }))).toBe(true)
    expect(Nudge.periodic("tool:call-2")).toBe(false)
    // A script hook's occurrence is a hash of its output: it changes exactly as often as the output
    // does, so it is NOT a period, and a chatty heartbeat has to say so with `spammable`.
    expect(Nudge.periodic("script:deadbeef")).toBe(false)
  })
})
