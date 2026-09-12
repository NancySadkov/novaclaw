import { describe, expect, test } from "bun:test"
import { commandElapsed, shellActionTitle, toolTimeoutMs } from "./shell-card"

describe("shell command card", () => {
  test("names common work for a non-expert", () => {
    expect(shellActionTitle("bun test src/a.test.ts")).toBe("Run tests")
    expect(shellActionTitle("rg -n hello packages")).toBe("Search the project")
    expect(shellActionTitle("git status --short")).toBe("Inspect changes")
    expect(shellActionTitle("mystery --flag")).toBe("Run a terminal command")
  })

  test("shows the enforced timeout beside live and completed command time", () => {
    expect(commandElapsed(1_000, undefined, 8_900, 90_000)).toBe("7s / 90s")
    expect(commandElapsed(1_000, 66_000, 90_000, 120_000)).toBe("65s / 120s")
  })

  test("formats decoded DateTime carriers without leaking NaN", () => {
    expect(commandElapsed({ epochMillis: 1_000 }, { epochMillis: 66_000 }, 90_000, 120_000)).toBe("65s / 120s")
    expect(commandElapsed(new Date(1_000), new Date(8_900), 90_000, 90_000)).toBe("7s / 90s")
    expect(commandElapsed({ epochMillis: Number.NaN }, undefined, 90_000)).toBeUndefined()
    expect(commandElapsed({}, {}, 90_000)).toBeUndefined()
  })

  test("uses the executor's defaults and honors an explicit shell deadline", () => {
    expect(toolTimeoutMs("bash", { command: "bun test" })).toBe(120_000)
    expect(toolTimeoutMs("bash", { job: "job_1", action: "wait" })).toBe(30_000)
    expect(toolTimeoutMs("bash", { command: "bun test", timeout: 45_000 })).toBe(45_000)
    expect(toolTimeoutMs("wait", { sessionID: "ses_child" })).toBe(420_000)
    expect(toolTimeoutMs("wait", { sessionID: "ses_child" }, 90_000)).toBe(90_000)
    expect(toolTimeoutMs("bash", { command: "bun test" }, 60_000)).toBe(60_000)
    expect(toolTimeoutMs("edit", { path: "src/a.ts" })).toBeUndefined()
  })
})
