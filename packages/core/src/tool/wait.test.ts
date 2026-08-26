import { describe, expect, test } from "bun:test"
import { deadChildMessage } from "./wait"

/**
 * 🔴 **The defect this exists for, measured 2026-08-27 on a delegated 100-file run:** `spawn:10`
 * against `wait:9` and `exit:9`. Ten children were started, nine were waited on and exited, and one
 * was launched and never accounted for. The run completed anyway, so nothing surfaced it.
 *
 * ⭐ That is the dangerous shape for a fan-out: nine slices of ten merge into a plausible,
 * complete-looking, WRONG answer, and the nine successes are precisely what hide the tenth.
 */
describe("deadChildMessage — a dead child must not read as a slow one", () => {
  test("a FAILED or INTERRUPTED child is reported as not-finished work to re-issue", () => {
    for (const state of ["failed", "interrupted"]) {
      const message = deadChildMessage("ses_child", state)
      expect(message).toBeDefined()
      // The three things the parent has to learn, because it will act on this sentence alone.
      expect(message).toContain("DID NOT FINISH")
      expect(message).toContain("waiting again will not help")
      expect(message).toContain("re-issue")
    }
  })

  test("it says WHICH failure, so the parent is not left guessing", () => {
    expect(deadChildMessage("ses_a", "failed")).toContain("failed")
    expect(deadChildMessage("ses_a", "interrupted")).toContain("was interrupted")
  })

  test("it names the child, because a fan-out has several", () => {
    expect(deadChildMessage("ses_seven", "failed")).toContain("ses_seven")
  })

  /**
   * 🔴 **The half that decides whether this is safe to ship.** Calling a LIVE child dead sends the
   * parent to duplicate work already in flight — the opposite error, and an expensive one on a device
   * this fan-out exists to saturate. `recovering` and `paused` are alive and will come back;
   * `starting`/`busy` obviously so.
   */
  test("every state that can still finish is NOT dead", () => {
    for (const state of ["starting", "busy", "recovering", "paused", "settled"])
      expect(deadChildMessage("ses_child", state)).toBeUndefined()
  })

  test("an ABSENT attempt row is not dead either — it may not have started", () => {
    expect(deadChildMessage("ses_child", undefined)).toBeUndefined()
    expect(deadChildMessage("ses_child", "")).toBeUndefined()
  })

  // ⚠️ A guard against the cheapest wrong implementation: `state !== "settled"` would pass every
  // positive test above and call a busy child dead.
  test("an unknown future state is treated as ALIVE, not dead", () => {
    expect(deadChildMessage("ses_child", "some-state-added-later")).toBeUndefined()
  })
})
