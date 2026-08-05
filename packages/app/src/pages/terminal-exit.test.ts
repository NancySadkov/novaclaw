import { describe, expect, test } from "bun:test"
import { shouldKeepExitedTab } from "./terminal-exit"

// terminal.md T2 asks for an explicit exited state AND its exit code. Before this rule every
// `pty.exited` removed the tab and the code was read off the event and discarded, so a shell that
// died abnormally deleted the output explaining why — at the moment that output is the only thing
// the user wants. The split below is the product judgement; these tests are what stop it drifting
// back to "always remove" during some later tidy-up.

describe("a clean exit closes, a failure stays", () => {
  test("exit 0 closes the tab", () => {
    // Typing `exit` must behave like every other terminal, or the panel becomes noise people learn
    // to dismiss without reading — which would cost exactly the case it exists for.
    expect(shouldKeepExitedTab(0)).toBe(false)
  })

  test("a non-zero exit keeps the tab", () => {
    for (const code of [1, 2, 127, 130, 137, 255]) expect(shouldKeepExitedTab(code)).toBe(true)
  })

  test("a missing code closes rather than stranding a tab nobody can explain", () => {
    // `exitCode` is optional on the wire. A kept tab whose panel cannot state a code would be a
    // dead terminal with no account of itself — worse than closing, because it looks actionable.
    expect(shouldKeepExitedTab(undefined)).toBe(false)
  })
})
