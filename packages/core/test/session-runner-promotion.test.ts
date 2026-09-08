import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness, userTexts } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — input promotion survives a fault on either side of its commit.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **The two claims here are the same question asked on both sides of one boundary**, and that is why
 * they live together. A user's prompt is promoted from the inbox and committed; around that commit sit
 * a PROJECTOR (which runs inside the transaction and can roll it back) and a LISTENER (which runs after
 * it and cannot). Both can fail, and the correct answers are opposites:
 *
 *   - projector defect → the promotion **rolled back**, so the input must still be in the inbox and a
 *     later wake must pick it up. Losing it here means a prompt the user typed is gone with no error
 *     they can act on, because the error they saw was the defect, not "your message was dropped".
 *   - listener defect  → the promotion **already committed**, so the run must proceed. Treating this as
 *     a failure would discard work that is durably recorded, and — worse — would make an unrelated
 *     subscriber able to veto every prompt in the system.
 *
 * A runner that handled faults uniformly around the commit gets exactly one of these right, whichever
 * way it chose. Neither test alone would notice.
 */

describe("SessionRunnerLLM — input promotion", () => {
  test("retries inbox input after prompt projection rolls back", async () => {
    // The projector runs INSIDE the promotion transaction, so its defect takes the promotion with it.
    const defect = new Error("fail after prompt promotion")
    let fail = true
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "Recovered")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* events.project(SessionEvent.Prompted, () => (fail ? Effect.die(defect) : Effect.void))
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Recover promoted input" }),
          resume: false,
        })

        expect(
          yield* session.resume(HARNESS_SESSION).pipe(Effect.catchDefect(Effect.succeed)),
          "the defect reaches the caller rather than being absorbed",
        ).toBe(defect)

        // The world is repaired, and the input must not have been consumed by the failed attempt.
        fail = false
        harness.requests.length = 0
        yield* (yield* SessionExecution.Service).wake(HARNESS_SESSION)
        while (harness.requests.length === 0) yield* Effect.yieldNow
      }),
      "claim — a rolled-back promotion leaves the input to retry",
    )

    expect(
      userTexts(harness.requests[0]!),
      "the same prompt, recovered from the inbox — not lost with the transaction",
    ).toEqual(["Recover promoted input"])
  })

  test("does not strand a committed promotion when a post-commit listener defects", async () => {
    // The listener runs AFTER the commit, so its defect cannot unmake the promotion — and must not be
    // allowed to stop the run that promotion exists to start.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "Ran anyway")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* events.listen((event) =>
          event.type === SessionEvent.Prompted.type ? Effect.die("fail after prompt promotion commits") : Effect.void,
        )
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Run committed promotion" }),
          resume: false,
        })

        harness.requests.length = 0
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a committed promotion is not stranded by a listener",
    )

    expect(harness.requests, "the turn runs — a listener cannot veto a committed prompt").toHaveLength(1)
    expect(userTexts(harness.requests[0]!)).toEqual(["Run committed promotion"])
  })
})
