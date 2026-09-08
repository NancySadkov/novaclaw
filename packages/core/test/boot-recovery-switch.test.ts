import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionBootRecovery } from "@novaclaw/core/session/boot-recovery"
import { SessionRecoveryDecision } from "@novaclaw/core/session/recovery-decision"

/**
 * ── THE `resumeInterrupted` SWITCH, AT ITS CALL SITE ─────────────────────────────────────────────
 *
 * 🔴 The FOURTH of five harness drives audited this session, and the third that had no proof its
 * gate is consulted. `boot-recovery-resume.test.ts` pins `resumeInterrupted` — the FILTER that
 * decides which recovered runs are safe to wake. Nothing pinned `start`, which is where the SWITCH
 * lives, so a gate that stopped being read would leave every one of those tests green while a user
 * who turned auto-resume off had their work resumed anyway.
 *
 * ⚠️ That direction matters more than the usual one. The other drives fail toward doing LESS for the
 * model; this one fails toward acting against an explicit instruction — the owner's Settings row says
 * *"turn this off if you would rather decide every restart yourself"*.
 *
 * ⚠️ **A thunk, not a boolean, and the test respects that.** `start` types it
 * `() => Effect<boolean>` so the store is consulted when a sweep actually recovers something, not
 * once at layer construction (*a settings change is not a reboot*). Asserting the CALL COUNT is what
 * separates "read per sweep" from "captured at startup", and a boolean parameter would have passed
 * either way.
 */

const recovered = [
  {
    sessionID: "ses_interrupted" as never,
    // The real policy's own verdict — `automatic: true` — so this test cannot pass by handing the
    // filter something it would have refused anyway.
    decision: SessionRecoveryDecision.decide({ phase: "provider", checkpointed: false, failureCount: 1 }),
  },
]

/** Drives the REAL `start`, with the two collaborators it forks stubbed to the shapes it calls. */
const runStart = async (resumeInterrupted?: () => Effect.Effect<boolean>) => {
  const woken: string[] = []
  let asked = 0
  const attempts = {
    recoverStale: () => Effect.sync(() => recovered),
  }
  const execution = { resume: (sessionID: string) => Effect.sync(() => void woken.push(sessionID)) }

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* SessionBootRecovery.start({
          // `wakeAbandonedInput` is forked beside the sweep and piped through `Effect.ignore`, so a
          // db it cannot use degrades instead of failing the test — which is the behaviour that
          // module documents for itself.
          db: {} as never,
          store: { get: () => Effect.succeed({ parentID: undefined, type: "interactive" }) } as never,
          attempts: attempts as never,
          execution: execution as never,
          ...(resumeInterrupted === undefined
            ? {}
            : {
                resumeInterrupted: () => {
                  asked++
                  return resumeInterrupted()
                },
              }),
        })
        // The first sweep runs immediately; the re-sweeps are what the 70 s window is for.
        yield* Effect.sleep("120 millis")
      }),
    ),
  )
  return { woken, asked }
}

describe("SessionBootRecovery.start asks harness_drives.resumeInterrupted", () => {
  test("ON (the default, switch absent): an interrupted run is woken", async () => {
    const { woken } = await runStart()
    expect(woken).toEqual(["ses_interrupted"])
  })

  test("ON (explicitly true): still woken", async () => {
    const { woken, asked } = await runStart(() => Effect.succeed(true))
    expect(woken).toEqual(["ses_interrupted"])
    expect(asked, "the thunk must actually be consulted").toBeGreaterThan(0)
  })

  // 🔴 THE ONE THE OWNER'S SETTINGS ROW PROMISES.
  test("OFF: the run is NOT woken — the switch is obeyed", async () => {
    const { woken, asked } = await runStart(() => Effect.succeed(false))
    expect(woken).toEqual([])
    expect(asked).toBeGreaterThan(0)
  })
})
