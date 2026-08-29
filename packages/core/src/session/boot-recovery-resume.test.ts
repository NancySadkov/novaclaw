import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionBootRecovery } from "./boot-recovery"
import { SessionRecoveryDecision } from "./recovery-decision"
import type { SessionExecutionAttempt } from "./execution-attempt"
import type { SessionSchema } from "./schema"

// Owner, 2026-08-29: *"why are crashed runs lost forever and can't be recovered / restored?"*
//
// 🔴 The answer was that `recoverStale` computed a recovery decision for every abandoned execution
// and nothing acted on it. These tests pin the acting — and above all pin WHICH runs are resumed,
// because the filter is the entire safety argument. Resuming a session the policy paused would
// re-run a tool whose outcome is unknown, or restart a run that has already killed the instance
// twice.

const id = (name: string) => name as SessionSchema.ID

const entry = (name: string, decision: SessionRecoveryDecision.Decision): SessionExecutionAttempt.Recovered => ({
  sessionID: id(name),
  decision,
})

/** The real policy's own verdicts, not hand-written booleans — so a change to `decide` reaches here. */
const verdicts = {
  beforeSideEffect: SessionRecoveryDecision.decide({ phase: "provider", checkpointed: false, failureCount: 1 }),
  repeatedFailure: SessionRecoveryDecision.decide({
    phase: "provider",
    checkpointed: false,
    failureCount: SessionRecoveryDecision.FAILURE_LIMIT,
  }),
  outcomeUnknown: SessionRecoveryDecision.decide({
    phase: "tool",
    checkpointed: false,
    failureCount: 1,
    toolSideEffect: "write",
    toolState: "dispatched",
  }),
}

const run = async (recovered: readonly SessionExecutionAttempt.Recovered[]) => {
  const woken: string[] = []
  const count = await Effect.runPromise(
    SessionBootRecovery.resumeInterrupted({
      recovered,
      wake: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
    }),
  )
  return { woken, count }
}

describe("resumeInterrupted", () => {
  // ⭐ THE MEASURED CASE: three sessions interrupted by a server hang, all safely resumable.
  test("wakes every run the policy judged automatically recoverable", async () => {
    const { woken, count } = await run([
      entry("ses_a", verdicts.beforeSideEffect),
      entry("ses_b", verdicts.beforeSideEffect),
      entry("ses_c", verdicts.beforeSideEffect),
    ])
    expect(woken).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(count).toBe(3)
  })

  // 🔴 THE CIRCUIT BREAKER. A run that keeps killing the instance is exactly the run most likely to
  // be interrupted again, so auto-resume without this bound is a crash-loop generator. The policy
  // already opens the breaker at FAILURE_LIMIT; this asserts the resume respects it.
  test("does NOT wake a run the breaker paused after repeated failures", async () => {
    expect(verdicts.repeatedFailure.automatic).toBe(false)
    const { woken, count } = await run([entry("ses_looper", verdicts.repeatedFailure)])
    expect(woken).toEqual([])
    expect(count).toBe(0)
  })

  // 🔴 THE SIDE-EFFECT HAZARD. A write tool that was dispatched without a durable result may or may
  // not have happened. Re-running it could duplicate it, which is why the policy says `inspect` and
  // a human decides.
  test("does NOT wake a run whose tool outcome is unknown", async () => {
    expect(verdicts.outcomeUnknown.automatic).toBe(false)
    const { woken } = await run([entry("ses_uncertain", verdicts.outcomeUnknown)])
    expect(woken).toEqual([])
  })

  // ⚠️ MIXED is the realistic sweep, and the one where a sloppy filter shows: two safe runs must be
  // resumed WITHOUT dragging the unsafe one along.
  test("resumes only the safe runs from a mixed sweep", async () => {
    const { woken, count } = await run([
      entry("ses_ok1", verdicts.beforeSideEffect),
      entry("ses_paused", verdicts.repeatedFailure),
      entry("ses_ok2", verdicts.beforeSideEffect),
      entry("ses_uncertain", verdicts.outcomeUnknown),
    ])
    expect(woken).toEqual(["ses_ok1", "ses_ok2"])
    expect(count).toBe(2)
  })

  test("an empty sweep wakes nothing and reports nothing", async () => {
    const { woken, count } = await run([])
    expect(woken).toEqual([])
    expect(count).toBe(0)
  })

  /**
   * 🔴 THE RATCHET ON THE POLICY ITSELF.
   *
   * This module's safety rests entirely on `decide` setting `automatic: false` for the two dangerous
   * shapes. If a later edit ever made either of them automatic, every test above would still pass —
   * they assert the filter, and the filter would be faithfully passing through a now-wrong verdict.
   * So the verdicts are asserted directly.
   */
  test("the policy still refuses to automate the two dangerous shapes", () => {
    expect(verdicts.repeatedFailure).toMatchObject({ action: "pause", automatic: false })
    expect(verdicts.outcomeUnknown).toMatchObject({ action: "inspect", automatic: false })
    expect(verdicts.beforeSideEffect.automatic).toBe(true)
  })
})
