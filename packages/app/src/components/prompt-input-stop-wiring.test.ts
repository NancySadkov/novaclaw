import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * 🔴 THE COMPOSER'S STOP CONTROL MUST STOP (owner, 2026-09-26).
 *
 * Three behaviours pinned here:
 *  1. the control is a Stop whenever the agent is WORKING, not only when the composer is blank
 *     (a leftover character flipped it to Send mid-turn and the click went to the send path);
 *  2. `disabled` never includes the stop's `pending()` — a stop that did not settle left the
 *     button disabled while still LOOKING like Stop, while Esc kept working;
 *  3. a pressed Stop shows a SPINNER until the agent settles, then play when the stopped turn
 *     can resume — the in-flight state is display-only and never disables the button.
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

  test("🔴 a pressed Stop spins until the agent settles, then offers play to resume", () => {
    const text = source()
    // The in-flight signal is read for DISPLAY, never for `disabled` (pinned above).
    expect(text).toContain('import { Spinner } from "@novaclaw/ui/spinner"')
    expect(text).toContain("props.stop?.pending()")
    // 🔴 …and the server half: the thread manager's own `stopping`, sampled through the
    // execution list — the scheduler acts on the same entry. One state, never a second opinion.
    expect(text).toContain("props.stop?.stopping()")
    expect(text).toContain("<Spinner")
    // The steady states are unchanged: Stop while working, play when a stopped turn can resume.
    expect(text).toContain('"stop"')
    expect(text).toContain('"play"')
  })
})
