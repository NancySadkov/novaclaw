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
// including delegated workers. An unknown tool outcome is resumed through an inspection steer
// rather than replayed.

const id = (name: string) => name as SessionSchema.ID

const entry = (name: string, decision: SessionRecoveryDecision.Decision): SessionExecutionAttempt.Recovered => ({
  sessionID: id(name),
  decision,
})

/** The real policy's own verdicts, not hand-written booleans — so a change to `decide` reaches here. */
const verdicts = {
  beforeSideEffect: SessionRecoveryDecision.decide({ phase: "provider", checkpointed: false, failureCount: 1 }),
  outcomeUnknown: SessionRecoveryDecision.decide({
    phase: "tool",
    checkpointed: false,
    failureCount: 1,
    // ⚠️ `non-idempotent` is the shape that makes this dangerous: a write that cannot be repeated
    // safely, dispatched with no durable result. `"write"` is not in the union at all — it typechecked
    // nowhere and the test still PASSED, because `bun test` does not typecheck. The full typecheck is
    // what caught it.
    toolSideEffect: "non-idempotent",
    toolState: "dispatched",
  }),
}

const run = async (recovered: readonly SessionExecutionAttempt.Recovered[]) => {
  const woken: string[] = []
  const count = await Effect.runPromise(
    SessionBootRecovery.resumeInterrupted({
      recovered,
      resume: (sessionID) => Effect.sync(() => void woken.push(sessionID)),
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

  test("joins each recovered run before starting the next", async () => {
    const order: string[] = []
    await Effect.runPromise(
      SessionBootRecovery.resumeInterrupted({
        recovered: [entry("ses_a", verdicts.beforeSideEffect), entry("ses_b", verdicts.beforeSideEffect)],
        resume: (sessionID) =>
          Effect.gen(function* () {
            order.push(`start:${sessionID}`)
            yield* Effect.sleep(10)
            order.push(`end:${sessionID}`)
          }),
      }),
    )
    expect(order).toEqual(["start:ses_a", "end:ses_a", "start:ses_b", "end:ses_b"])
  })

  test("one failed recovery does not strand the remaining runs", async () => {
    const resumed: string[] = []
    const count = await Effect.runPromise(
      SessionBootRecovery.resumeInterrupted({
        recovered: [entry("ses_bad", verdicts.beforeSideEffect), entry("ses_ok", verdicts.beforeSideEffect)],
        resume: (sessionID) =>
          sessionID === id("ses_bad") ? Effect.fail("worker failed") : Effect.sync(() => void resumed.push(sessionID)),
      }),
    )
    expect(resumed).toEqual(["ses_ok"])
    expect(count).toBe(2)
  })

  test("resumes spawned workers instead of stranding their parent's durable wait", async () => {
    const { woken, count } = await run([
      entry("ses_officer", verdicts.beforeSideEffect),
      entry("ses_worker", verdicts.beforeSideEffect),
    ])
    expect(woken).toEqual(["ses_officer", "ses_worker"])
    expect(count).toBe(2)
  })

  test("resumes descendants before an officer that may be waiting for them", async () => {
    const order: string[] = []
    const parents = new Map([
      ["ses_officer", undefined],
      ["ses_worker", "ses_officer"],
      ["ses_grandchild", "ses_worker"],
    ])
    await Effect.runPromise(
      SessionBootRecovery.resumeInterrupted({
        recovered: [
          entry("ses_officer", verdicts.beforeSideEffect),
          entry("ses_worker", verdicts.beforeSideEffect),
          entry("ses_grandchild", verdicts.beforeSideEffect),
        ],
        parentOf: (sessionID) => Effect.succeed(parents.get(sessionID) as SessionSchema.ID | undefined),
        resume: (sessionID) =>
          Effect.sync(() => {
            order.push(sessionID)
          }),
      }),
    )
    expect(order).toEqual(["ses_grandchild", "ses_worker", "ses_officer"])
  })

  // 🔴 THE SIDE-EFFECT HAZARD. A write tool that was dispatched without a durable result may or may
  // not have happened. The new process must wake, but `inspect` makes the officer ground itself in
  // actual state rather than replaying the call.
  test("wakes a run whose tool outcome is unknown through inspection", async () => {
    expect(verdicts.outcomeUnknown).toMatchObject({ action: "inspect", automatic: true })
    const { woken } = await run([entry("ses_uncertain", verdicts.outcomeUnknown)])
    expect(woken).toEqual(["ses_uncertain"])
  })

  test("resumes every recoverable boundary from a mixed sweep", async () => {
    const { woken, count } = await run([
      entry("ses_ok1", verdicts.beforeSideEffect),
      entry("ses_ok2", verdicts.beforeSideEffect),
      entry("ses_uncertain", verdicts.outcomeUnknown),
    ])
    expect(woken).toEqual(["ses_ok1", "ses_ok2", "ses_uncertain"])
    expect(count).toBe(3)
  })

  test("an empty sweep wakes nothing and reports nothing", async () => {
    const { woken, count } = await run([])
    expect(woken).toEqual([])
    expect(count).toBe(0)
  })

  test("the policy resumes unknown effects through inspection", () => {
    expect(verdicts.outcomeUnknown).toMatchObject({ action: "inspect", automatic: true })
    expect(verdicts.beforeSideEffect.automatic).toBe(true)
  })
})
