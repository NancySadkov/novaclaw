import { describe, expect, test } from "bun:test"
import { shouldCloneTerminal, terminalConnectFailureMessage } from "./terminal-connection"

describe("terminal connection recovery", () => {
  test("clones only a PTY confirmed gone", () => {
    expect(shouldCloneTerminal({ kind: "gone", error: new Error("gone") })).toBe(true)
    expect(shouldCloneTerminal({ kind: "blocked", error: new Error("forbidden") })).toBe(false)
    expect(shouldCloneTerminal({ kind: "unavailable", error: new Error("offline") })).toBe(false)
  })

  test("keeps a useful connection failure message", () => {
    expect(terminalConnectFailureMessage({ kind: "blocked", error: new Error("origin rejected") }, "fallback")).toBe(
      "origin rejected",
    )
    expect(terminalConnectFailureMessage({ kind: "unavailable", error: undefined }, "fallback")).toBe("fallback")
  })
})
