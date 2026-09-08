import { describe, expect, test } from "bun:test"
import { commandElapsed, shellActionTitle } from "./shell-card"

describe("shell command card", () => {
  test("names common work for a non-expert", () => {
    expect(shellActionTitle("bun test src/a.test.ts")).toBe("Run tests")
    expect(shellActionTitle("rg -n hello packages")).toBe("Search the project")
    expect(shellActionTitle("git status --short")).toBe("Inspect changes")
    expect(shellActionTitle("mystery --flag")).toBe("Run a terminal command")
  })

  test("formats live and completed elapsed time", () => {
    expect(commandElapsed(1_000, undefined, 8_900)).toBe("7s")
    expect(commandElapsed(1_000, 66_000, 90_000)).toBe("1m 5s")
  })

  test("formats decoded DateTime carriers without leaking NaN", () => {
    expect(commandElapsed({ epochMillis: 1_000 }, { epochMillis: 66_000 }, 90_000)).toBe("1m 5s")
    expect(commandElapsed(new Date(1_000), new Date(8_900), 90_000)).toBe("7s")
    expect(commandElapsed({ epochMillis: Number.NaN }, undefined, 90_000)).toBeUndefined()
    expect(commandElapsed({}, {}, 90_000)).toBeUndefined()
  })
})
