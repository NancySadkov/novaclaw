import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionStore } from "@novaclaw/core/session/store"
import { HARNESS_SESSION, drive, makeLatch, makeRunnerHarness, userTexts } from "./fixture/runner-harness"
import { fragmentFixture } from "./fixture/fragments"

/**
 * PORTED CLAIMS — compaction.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * 🔴 **Two setup facts cost four iterations of investigation. Read them before adding a claim here.**
 *
 * **① The priming conversation needs THREE exchanges, not two — length does not substitute for count.**
 * `selectContext` picks a split by tokens and then walks it back to a message boundary:
 * `while (recentStart > 0 && conversation[recentStart - 1] is not assistant) recentStart--`. With only
 * two exchanges the split lands right after message 0, the walk drives `recentStart` to **0**, and
 * `head` comes back EMPTY — so `compactAfterOverflow` returns false *before* any provider call. Making
 * the prompts longer does not help; it moves the split, not the boundary.
 *
 * **② `compact()` SCHEDULES.** Asserting on the next line sees nothing, and a probe that returns
 * immediately never even produces the settle log — which is how a false "the config is not applied"
 * conclusion was reached. Wait for the compaction events.
 *
 * (A third fact lives in the harness: the summary request carries no system prompt, so the fixture has
 * to recognise it by name or it is classified as an out-of-band utility pass and starved.)
 */

describe("SessionRunnerLLM — compaction", () => {
  test("manual compact runs a compact-only cycle with reason manual and drains no turn", async () => {
    // A MANUAL compact is not a turn. It summarises and stops — no model turn follows, because nothing
    // was pending. That "drains no turn" half is the one worth guarding: a compaction that helpfully
    // continued would burn a turn the user never asked for, and on a slow local model that is minutes
    // of unwanted work.
    const started = makeLatch()
    const ended = makeLatch()
    let startedReason: string | undefined
    let endedData: { reason?: string; text?: string } | undefined

    const harness = makeRunnerHarness({
      turns: [
        fragmentFixture("text", "t1", ["First answer"]).completeEvents,
        fragmentFixture("text", "t2", ["Second answer"]).completeEvents,
        fragmentFixture("text", "t3", ["Third answer"]).completeEvents,
        fragmentFixture("text", "text-manual-summary", ["## Goal\n- Manual summary"]).completeEvents,
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service

        for (const text of ["First question ", "Second question ", "Third question "]) {
          yield* session.prompt({
            sessionID: HARNESS_SESSION,
            prompt: Prompt.make({ text: text.repeat(180) }),
            resume: false,
          })
          yield* session.resume(HARNESS_SESSION)
        }

        // ⚠️ The listener does the MINIMUM: capture a reference, open a latch. Real work in an event
        // callback is a documented way to wedge the process (AGENTS.md pitfall #8).
        const unsubscribe = yield* events.listen((event) => {
          if (event.type === SessionEvent.Compaction.Started.type) {
            startedReason = (event.data as { reason?: string }).reason
            started.open()
          }
          if (event.type === SessionEvent.Compaction.Ended.type) {
            endedData = event.data as { reason?: string; text?: string }
            ended.open()
          }
          return Effect.void
        })
        yield* Effect.addFinalizer(() => unsubscribe)

        harness.controls.currentModel = harness.makeModel("compact", { context: 4_000, output: 50 })
        harness.requests.length = 0

        yield* session.compact({ sessionID: HARNESS_SESSION })
        yield* Effect.promise(() => started.promise)
        yield* Effect.promise(() => ended.promise)

        return yield* (yield* SessionStore.Service).context(HARNESS_SESSION)
      }),
      "claim — manual compact is a compact-only cycle",
    )

    expect(startedReason).toBe("manual")
    expect(endedData?.reason).toBe("manual")
    expect(endedData?.text).toBe("## Goal\n- Manual summary")
    // Exactly ONE provider request: the summary. No turn followed it.
    expect(harness.requests, "a manual compact must not drain a turn as well").toHaveLength(1)
    expect(userTexts(harness.requests[0]!)[0]).toContain("anchored summary")
    expect(context[0]).toMatchObject({ type: "compaction", summary: "## Goal\n- Manual summary" })
  })
})
