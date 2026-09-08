import { describe, expect, test } from "bun:test"
import { toolInputForDisplay } from "./tool-input-preview"

describe("toolInputForDisplay", () => {
  test("returns structured input for a running tool", () => {
    const input = { path: "src/complete.ts", oldString: "before" }
    expect(toolInputForDisplay({ status: "running", input })).toBe(input)
  })

  test("exposes a completed path while the rest of a pending edit is still streaming", () => {
    expect(
      toolInputForDisplay({
        status: "pending",
        input: '{"path":"src/live-edit.ts","oldString":"a large unfinished value',
      }),
    ).toEqual({ path: "src/live-edit.ts" })
  })

  test("decodes escapes and multiple completed top-level members", () => {
    expect(
      toolInputForDisplay({
        status: "pending",
        input: '{"path":"src\\\\windows\\\\file.ts","offset":12,"options":{"nested":true},"next":',
      }),
    ).toEqual({ path: "src\\windows\\file.ts", offset: 12, options: { nested: true } })
  })

  test("does not guess from an incomplete path or nested path-shaped text", () => {
    expect(toolInputForDisplay({ status: "pending", input: '{"path":"src/not-yet' })).toEqual({})
    expect(toolInputForDisplay({ status: "pending", input: 'prefix {"path":"src/decoy.ts"}' })).toEqual({})
  })

  test("treats model-supplied prototype keys as ordinary data", () => {
    const input = toolInputForDisplay({ status: "pending", input: '{"__proto__":{"polluted":true},"path":"safe.ts"' })
    expect(Object.hasOwn(input, "__proto__")).toBe(true)
    expect(input.path).toBe("safe.ts")
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
