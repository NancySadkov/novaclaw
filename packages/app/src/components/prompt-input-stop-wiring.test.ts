import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 THE COMPOSER'S STOP CONTROL MUST STOP (owner, 2026-09-26).
 *
 * Two separate reasons a click was ignored, both pinned here:
 *  1. the control was only a "Stop" when `working() && blank()`, so a leftover character — or any
 *     disagreement in `blank()` — flipped it to Send mid-turn and the click went to the send path;
 *  2. `disabled` included `stopping() && stop.pending()`, and a stop that did not settle left
 *     `pending` true, so the button sat disabled while still LOOKING like Stop. Esc kept working
 *     because it calls `abort()` directly and never touches the button.
 *
 * ⚠️ This reads source because the composer is a `.tsx` the unit tier cannot mount with all of its
 * context, and because the failure is a WIRING one. It asserts the handler exists, not that a real
 * turn stops — that is exercised live.
 */
const source = () =>
  readFileSync(join(import.meta.dir, "prompt-input.tsx"), "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//") && !line.trimStart().startsWith("*"))
    .join("\n")

describe("the composer Stop control", () => {
  test("🔴 is a Stop whenever the agent is WORKING, not only when the composer is blank", () => {
    expect(source(), "the stop predicate moved — re-point this test, do not delete it").toContain(
      "const stopping = createMemo(() => working())",
    )
  })

  test("🔴 its click runs abort() — Esc's path — and a stuck stop cannot disable it", () => {
    const text = source()
    expect(text).toContain("void abort()")
    // The disabled expression must NOT include the stop's `pending()`.
    expect(text).toContain("disabled={!working() && blank() && !resuming()}")
    expect(text).not.toContain("stopping() && !!props.stop?.pending()")
  })
})
