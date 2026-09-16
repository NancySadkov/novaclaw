import { stripAnsi } from "./test-output"

/**
 * The most actionable excerpt we can put on a summary ROW.
 *
 * 🔴 **A matcher name is not a diagnosis, and this function used to return one.** Measured 2026-09-16:
 * `core`'s sharded runs reported an unrelated flake with the excerpt
 * *"error: expect(received).toEqual(expected)"* — the line that names the MATCHER and none of the
 * values, so the one fact that would have identified it (expected versus received) was dropped by the
 * runner and the investigation had to start again from the test's source. The diff lines immediately
 * after that line ARE the diagnosis.
 *
 * ⚠️ It lives here, not inline in `test.ts`, for the reason `commit-pressure.ts` does: *"the judgement
 * lives in `lib/`, where it is pure and tested"*. `test.ts` is the runner — importing it runs the whole
 * suite — so a judgement parked inside it can never be exercised, and this one silently produced a
 * useless row for months.
 *
 * ⚠️ Still bounded, because this is a row in a summary and not a log. A tsgo diagnostic names its file
 * and its code on ONE line; a runtime failure names its matcher there and its values BELOW, so only the
 * latter earns a tail.
 */
export const EXCERPT_MAX = 220

/** `src/foo.ts(3,31): error TS4104: The type 'readonly string[]' is 'readonly' ...`. */
const TS_DIAGNOSTIC = /\berror TS\d+\b/

export function failureExcerpt(output: string): string {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  // The precedence is by ACTIONABILITY, and it is the original order: a tsgo diagnostic names its file
  // and code; a runtime `error:` line names its matcher and is followed by the Expected/Received diff;
  // a `(fail)` line only names the test, which `failing:` in the summary already lists. ⚠️ Collapsing
  // these into one `findIndex` over a combined predicate silently prefers whichever line happens to
  // come FIRST in the output — and bun prints `(fail) <name>` BEFORE `error: <matcher>`, so the diff
  // was dropped and the row went back to naming a matcher with no values. Its own test caught that.
  const first = (predicate: (line: string) => boolean) => lines.findIndex(predicate)
  const tsIndex = first((line) => TS_DIAGNOSTIC.test(line))
  const errorIndex = first((line) => /^error[:\s]/i.test(line))
  const failIndex = first((line) => line.includes("(fail)"))
  const index = tsIndex !== -1 ? tsIndex : errorIndex !== -1 ? errorIndex : failIndex
  const pick = index === -1 ? (lines.at(-1) ?? "") : lines[index]!
  if (!pick) return ""
  const isDiagnostic = index !== -1 && index === tsIndex
  const tail = index !== -1 && !isDiagnostic ? lines.slice(index + 1, index + 3) : []
  const text = [pick, ...tail].join(" · ")
  return text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 3)}...` : text
}
