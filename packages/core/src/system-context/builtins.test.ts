import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { environmentUpdate } from "./builtins"

/**
 * ── CACHE-004: THE ENVIRONMENT UPDATE IS A DIFF, NOT A RE-RENDER ─────────────────────────────────
 *
 * Exception-only environment facts such as an unavailable MCP server can appear, change and clear
 * during a session. Repeating the whole stable platform block for one changed line deposits
 * near-duplicate text in the durable transcript and every later compaction.
 *
 * Resource pressure no longer travels through this path: it is a targeted, configurable Nudge. This
 * helper remains the diff boundary for the exception facts which still belong in `<env>`.
 */

const env = (...lines: string[]) => ["<env>", ...lines.map((line) => `  ${line}`), "</env>"].join("\n")

const PLATFORM = "Platform: win32"
const SHELL = "Shell: C:\soft\Git\bin\bash.exe"
const OFFLINE = 'MCP server "search" is configured but unavailable: connection refused.'
const AUTH = 'MCP server "search" is configured but unavailable: authentication required.'

describe("environmentUpdate", () => {
  test("a changed exception emits ONE line, not the whole block", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL, OFFLINE), env(PLATFORM, SHELL, AUTH))
    expect(update).toContain("authentication required")
    // 🔴 The point of the change: the unchanged lines must NOT be re-sent.
    expect(update).not.toContain(PLATFORM)
    expect(update).not.toContain("Shell:")
    expect(update.length).toBeLessThan(160)
  })

  /**
   * 🔴 THE CASE A NAIVE "WHAT IS NEW" DIFF SILENTLY DROPS, and the one that matters most: the model
   * must learn that a warning CLEARED, or it keeps avoiding memory-intensive work forever.
   */
  test("an exception that CLEARS is reported, not silently omitted", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL, OFFLINE), env(PLATFORM, SHELL))
    expect(update).toContain("No longer applies")
    expect(update).toContain("connection refused")
  })

  test("an exception that APPEARS is reported", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL), env(PLATFORM, SHELL, OFFLINE))
    expect(update).toContain("connection refused")
    expect(update).not.toContain("No longer applies")
  })

  // ⚠️ Wrapper or whitespace churn with no line-level change must not produce an empty notice.
  test("falls back to the full render when nothing line-level differs", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL), `${env(PLATFORM, SHELL)}\n`)
    expect(update).toContain("is now:")
    expect(update).toContain(PLATFORM)
  })
})

/**
 * 🔴 THE WIRING. Every test above imports `environmentUpdate` directly and passes just as well if
 * `builtins` never calls it — the helper-proven-then-never-called shape this repo has shipped
 * repeatedly. Asserted on SOURCE because the update function lives inside a `SystemContext.combine`
 * closure with no handle to reach it, and building a registry + epoch + store to read one string back
 * would be a larger fixture than the thing under test.
 *
 * ⚠️ It asserts its ANCHOR was found first: a pattern that matches nothing must not read as a pattern
 * that matched something correct.
 */
test("core/environment is wired to the diff, not to a full re-render", () => {
  const source = readFileSync(new URL("./builtins.ts", import.meta.url), "utf8")
  expect(source, "the core/environment source moved — re-point this, do not delete it").toContain(
    'SystemContext.Key.make("core/environment")',
  )
  expect(source).toContain("update: (previous, current) => environmentUpdate(previous.rendered, current.rendered),")
  expect(source).toContain("equivalent: environmentEquivalent,")
  expect(source, "the old whole-block re-render must not come back for this key").not.toContain(
    'update: (_previous, environment) => ["The environment you are running in is now:"',
  )
})
