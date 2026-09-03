import { describe, expect, test } from "bun:test"
import { elapsedMs, phaseLabel } from "./turn-receipt"

/**
 * THE RECEIPT'S CLOCK IS ABOUT THE RUN, NOT THE TURN.
 *
 * Owner, 2026-09-03: *"the time on the `Writing the answer...` also resets after each agent's
 * action, instead of keeping the total so the user could see how long the work is going on."*
 *
 * The cause: the summary took its clock from `timing.startedAt`, which is the start of THIS provider
 * turn. A step that calls a tool ends one turn and begins the next, so the number restarted at every
 * action while the user was waiting on one continuous piece of work — the exact moment they most
 * want to know how long it has been.
 *
 * These assert the ARITHMETIC that decides it. The wiring (a run start held across turns and cleared
 * only when the session stops being busy) lives in `native-transcript.tsx`; what is testable without
 * a DOM is that a run-scoped anchor and a turn-scoped one give different answers, and which one
 * keeps counting.
 */
describe("elapsed is measured from the run, not the turn", () => {
  const runStartedAt = 1_000
  const secondTurnStartedAt = 9_000
  const now = 12_000

  test("🔴 a turn-scoped anchor RESETS — this is the defect, stated as a number", () => {
    // The second turn began at 9s, so its own clock reads 3s while the user has been waiting 11s.
    expect(elapsedMs(secondTurnStartedAt, undefined, now)).toBe(3_000)
  })

  test("🔴 a run-scoped anchor keeps counting across the turn boundary", () => {
    expect(elapsedMs(runStartedAt, undefined, now)).toBe(11_000)
  })

  test("CONTROL — a SETTLED turn still reports its own duration, not the run's", () => {
    // The fix must not rewrite history: a finished turn's row is about that turn. Only the LIVE
    // summary follows the run, which is why the component passes the anchor only when live.
    expect(elapsedMs(secondTurnStartedAt, 10_500, now)).toBe(1_500)
  })

  test("CONTROL — a completed run is measured to its completion, not to now", () => {
    expect(elapsedMs(runStartedAt, 11_000, now)).toBe(10_000)
  })
})

/**
 * ⚠️ The other half of the same complaint: *"`Writing the answer...` … is really just a mislabel for
 * a bunch of stats"*. The fold's title used to be the CURRENT PHASE's label, so a fold listing every
 * stage was named after whichever stage happened to be running — and renamed itself every few
 * seconds while the user was reading it. The phase labels are still right for the ROWS inside; they
 * were only wrong as the name of the container.
 */
describe("phase labels name stages, and stages go inside the fold", () => {
  test("the label that was being used as a title is a STAGE name", () => {
    expect(phaseLabel("generation")).toBe("Writing the answer")
    expect(phaseLabel("provider-prefill")).toBe("Waiting for the model")
  })
})
