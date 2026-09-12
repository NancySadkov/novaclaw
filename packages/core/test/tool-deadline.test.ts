import { describe, expect, test } from "bun:test"
import { ToolDeadline } from "@novaclaw/core/tool-deadline"

describe("tool deadline", () => {
  test("uses the ten-minute officer default and refuses larger explicit timeouts", () => {
    expect(ToolDeadline.resolve("bash", { command: "work" }).limitMs).toBe(600_000)
    expect(ToolDeadline.exceedsLimit("bash", { command: "work", timeout: 600_000 })).toBeUndefined()
    expect(ToolDeadline.exceedsLimit("bash", { command: "work", timeout: 600_001 })).toMatchObject({
      requestedMs: 600_001,
      limitMs: 600_000,
    })
  })

  test("applies an officer override and webfetch's seconds unit", () => {
    expect(ToolDeadline.resolve("wait", {}, 90_000).timeoutMs).toBe(90_000)
    expect(ToolDeadline.exceedsLimit("webfetch", { timeout: 91 }, 90_000)).toMatchObject({
      requestedMs: 91_000,
      limitMs: 90_000,
    })
  })

  test("gives the model a corrective refusal", () => {
    const deadline = ToolDeadline.exceedsLimit("bash", { timeout: 700_000 })!
    expect(ToolDeadline.refusal("bash", deadline)).toContain("Nothing ran")
    expect(ToolDeadline.refusal("bash", deadline)).toContain("600000 ms or less")
  })
})
