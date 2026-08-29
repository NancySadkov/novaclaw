import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  BACKOFF_RESET_ALIVE_MS,
  FAST_CRASH_GIVEUP,
  RESTART_BACKOFF_CAP_MS,
  RESTART_BACKOFF_START_MS,
} from "./supervise"

/**
 * ── THE RESTART POLICY EXISTS TWICE, IN TWO LANGUAGES ────────────────────────────────────────────
 *
 * 🔴 This file's own header calls itself *"the shared boundary between the headless server and
 * Electron main process; one implementation keeps their recovery behavior identical."* The Rust
 * watchdog (`packages/watchdog`) then hand-copied three of its numbers, because a supervisor that
 * lives OUTSIDE the process it restarts cannot import TypeScript from inside it.
 *
 * That is a legitimate constraint and an illegitimate place to stop. A hand-kept copy of somebody
 * else's constants goes stale in exactly one direction — silently, in the copy nobody edits — and
 * the failure it produces is the worst kind: both supervisors work, neither test fails, and the two
 * layers disagree about how fast to give a dying instance another chance. Nothing in either language
 * can see the other, so this test is the only place the two can be held to each other.
 *
 * ⚠️ It reads Rust SOURCE, which makes it a text test, and text tests lie in a specific way: a
 * pattern that matches nothing looks exactly like a pattern that matches something correct. Every
 * extraction below therefore asserts it FOUND its constant before comparing it, and comments are
 * stripped first — this repo has already shipped one regex that counted its own prose.
 */

const WATCHDOG = join(import.meta.dir, "..", "..", "watchdog", "src", "main.rs")

/** Rust source with `//`-comments removed, so a number quoted in a doc-comment cannot be read as code. */
const code = (): string => {
  const raw = readFileSync(WATCHDOG, "utf8")
  expect(raw, "the watchdog source must be readable from here — a moved file must fail LOUDLY").toContain(
    "const BACKOFF_MS",
  )
  // Block comments would need real parsing; assert there are none rather than pretend to handle them.
  expect(raw).not.toContain("/*")
  return raw
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
}

/** The value of `const NAME…= <number>;`, underscores removed. Throws rather than returning a default. */
const constant = (source: string, name: string): number => {
  const at = source.indexOf(`const ${name}`)
  expect(at, `${name} must exist in the watchdog's CODE, not only in its comments`).toBeGreaterThan(-1)
  const eq = source.indexOf("=", at)
  const end = source.indexOf(";", eq)
  const value = Number(source.slice(eq + 1, end).replaceAll("_", "").trim())
  expect(Number.isFinite(value), `${name} did not parse as a number`).toBe(true)
  return value
}

/** The `[a, b, …]` array literal of `const NAME`, underscores removed. */
const ladder = (source: string, name: string): readonly number[] => {
  const at = source.indexOf(`const ${name}`)
  expect(at, `${name} must exist in the watchdog's CODE`).toBeGreaterThan(-1)
  const open = source.indexOf("[", source.indexOf("=", at))
  const close = source.indexOf("]", open)
  const values = source
    .slice(open + 1, close)
    .split(",")
    .map((part) => Number(part.replaceAll("_", "").trim()))
  expect(values.length, `${name} parsed as an empty ladder — the extraction is broken, not the policy`).toBeGreaterThan(1)
  for (const value of values) expect(Number.isFinite(value)).toBe(true)
  return values
}

describe("the Rust watchdog and the TypeScript supervisor agree on the numbers they share", () => {
  test("the first retry is as prompt in both", () => {
    expect(ladder(code(), "BACKOFF_MS")[0]).toBe(RESTART_BACKOFF_START_MS)
  })

  test("and both stop backing off at the same ceiling", () => {
    const rungs = ladder(code(), "BACKOFF_MS")
    expect(rungs.at(-1)).toBe(RESTART_BACKOFF_CAP_MS)
  })

  // 🔴 THE ONE THAT MATTERS MOST. If the two layers disagree about how long a start must survive to
  // count, they disagree about what a crash-LOOP is — and the outer one can be climbing its ladder
  // while the inner one believes every start succeeded.
  test("and on how long a start must survive to count as healthy", () => {
    expect(constant(code(), "HEALTHY_AFTER_MS")).toBe(BACKOFF_RESET_ALIVE_MS)
  })

  test("the ladder doubles from the floor to the ceiling without a gap or a step backwards", () => {
    const rungs = ladder(code(), "BACKOFF_MS")
    for (let i = 1; i < rungs.length; i++) {
      const previous = rungs[i - 1]!
      expect(rungs[i]!).toBeGreaterThan(previous)
      expect(rungs[i]!).toBe(Math.min(previous * 2, RESTART_BACKOFF_CAP_MS))
    }
  })

  /**
   * ⚠️ THE DIVERGENCE IS DELIBERATE, SO IT IS PINNED TOO.
   *
   * The in-process supervisor gives up after `FAST_CRASH_GIVEUP` fast crashes and reports `gave-up`
   * to a UI a human is looking at. The watchdog has no UI to report to — giving up there produces
   * precisely the outcome it was built to prevent (owner, 2026-08-29: *"why are crashed runs lost
   * forever and can't be recovered?"*), so it caps the RATE instead and keeps trying.
   *
   * This asserts the watchdog has NOT quietly grown a giveup of its own. If someone adds one, this
   * test fails and makes them reconcile the two designs on purpose rather than by drift.
   */
  test("only the in-process supervisor gives up; the watchdog caps the rate and keeps trying", () => {
    expect(FAST_CRASH_GIVEUP).toBeGreaterThan(0)
    const source = code()
    expect(source).not.toContain("GIVEUP")
    expect(source).not.toContain("GIVE_UP")
  })
})
