import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { environmentUpdate } from "./builtins"

/**
 * ── CACHE-004: THE ENVIRONMENT UPDATE IS A DIFF, NOT A RE-RENDER ─────────────────────────────────
 *
 * 🔴 Measured 2026-08-29 on a live N=400 sweep with the box at 92 % commit: **13 of 66 session
 * messages carried an `<env>` block and all 13 renders were DISTINCT**, differing only in the
 * megabyte figure that `resource-pressure-context.ts` probes live. The control is the same rig and
 * corpus on a quiet box: **0 of 217**. So this fires exactly while a long sweep is running.
 *
 * ⚠️ It is a TAIL update and does NOT invalidate the prefix cache — a claim made and withdrawn the
 * same day. The cost is ~250 characters of near-duplicate text deposited in the DURABLE transcript
 * every time, carried by every later turn and re-summarised by every compaction, spent precisely
 * when the machine is already short.
 */

const env = (...lines: string[]) => ["<env>", ...lines.map((line) => `  ${line}`), "</env>"].join("\n")

const PLATFORM = "Platform: win32"
const SHELL = "Shell: C:\soft\Git\bin\bash.exe"
const LOW = "Memory headroom is low: 40655 MB of 43954 MB committed. Avoid memory-intensive work."
const LOWER = "Memory headroom is low: 41354 MB of 43954 MB committed. Avoid memory-intensive work."

describe("environmentUpdate", () => {
  test("a moving megabyte figure emits ONE line, not the whole block", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL, LOW), env(PLATFORM, SHELL, LOWER))
    expect(update).toContain("41354 MB")
    // 🔴 The point of the change: the unchanged lines must NOT be re-sent.
    expect(update).not.toContain(PLATFORM)
    expect(update).not.toContain("Shell:")
    expect(update.length).toBeLessThan(160)
  })

  /**
   * 🔴 THE CASE A NAIVE "WHAT IS NEW" DIFF SILENTLY DROPS, and the one that matters most: the model
   * must learn that a warning CLEARED, or it keeps avoiding memory-intensive work forever.
   */
  test("a warning that CLEARS is reported, not silently omitted", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL, LOW), env(PLATFORM, SHELL))
    expect(update).toContain("No longer applies")
    expect(update).toContain("40655 MB")
  })

  test("a warning that APPEARS is reported", () => {
    const update = environmentUpdate(env(PLATFORM, SHELL), env(PLATFORM, SHELL, LOW))
    expect(update).toContain("40655 MB")
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
