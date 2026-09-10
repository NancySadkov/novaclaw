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
