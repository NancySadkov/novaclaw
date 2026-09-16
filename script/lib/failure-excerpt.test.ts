import { describe, expect, test } from "bun:test"
import { EXCERPT_MAX, failureExcerpt } from "./failure-excerpt"

/**
 * THE SUMMARY ROW A FAILURE HAS TO SURVIVE IN.
 *
 * 🔴 Owner-visible consequence, measured 2026-09-16: `core`'s sharded runs each failed a DIFFERENT
 * unrelated test, and the summary reduced every one of them to *"error: expect(received).
 * toEqual(expected)"* — the matcher's name and neither value. Four runs produced four useless rows, so
 * the failures could not be told apart from each other or from a real defect, and the investigation had
 * to re-run each file to learn anything. The remainder of the class is that a judgement parked inside
 * `test.ts` cannot be exercised at all; hence this file.
 */

describe("failureExcerpt", () => {
  test("🔴 a matcher failure carries the EXPECTED/RECEIVED lines, not just the matcher's name", () => {
    const output = [
      "(fail) some suite > a claim [12.34ms]",
      "",
      "error: expect(received).toEqual(expected)",
      "",
      "- Expected  - 1",
      "+ Received  + 2",
      "",
      "      at <anonymous> (packages/core/test/thing.test.ts:42:5)",
    ].join("\n")
    const excerpt = failureExcerpt(output)
    expect(excerpt).toContain("toEqual(expected)")
    // The values. Without these the row names a matcher and nothing else.
    expect(excerpt).toContain("Expected")
    expect(excerpt).toContain("Received")
  })

  test("a tsgo diagnostic stays ONE line — its neighbours are other files' diagnostics", () => {
    const output = [
      "src/a.ts(1,1): error TS4104: The type 'x' is not assignable.",
      "src/b.ts(9,1): error TS2322: Type 'y' is not assignable.",
    ].join("\n")
    const excerpt = failureExcerpt(output)
    expect(excerpt).toContain("TS4104")
    expect(excerpt).not.toContain("TS2322")
    expect(excerpt).not.toContain(" · ")
  })

  test("ANSI is stripped, so a row is readable in a redirected log", () => {
    const excerpt = failureExcerpt("\u001b[31merror: boom\u001b[0m")
    expect(excerpt).toBe("error: boom")
  })

  test("a long excerpt is truncated and SAYS so, rather than being cut mid-word silently", () => {
    const excerpt = failureExcerpt(`error: ${"x".repeat(400)}`)
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX)
    expect(excerpt.endsWith("...")).toBe(true)
  })

  test("nothing readable yields nothing, never a placeholder", () => {
    expect(failureExcerpt("")).toBe("")
    expect(failureExcerpt("   \n\n  ")).toBe("")
  })

  test("with no recognisable marker the LAST line is used, as before", () => {
    // The tail case for a runner that printed something unexpected: the bottom of the output is where
    // a crash leaves its reason.
    expect(failureExcerpt("starting\nsomething went wrong")).toBe("something went wrong")
  })
})
