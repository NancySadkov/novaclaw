import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { LLMError, LLMEvent, TransportReason } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeLatch, makeRunnerHarness, userTexts } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — steering a turn that is already in flight.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **This whole family is about WHEN, and needs the provider held open to state it.** A prompt that
 * arrives during a turn must reach the NEXT request, not the one already in flight; a transcript alone
 * cannot distinguish that from a prompt that simply arrived late, because both end with the same two
 * turns. `controls.streamStarted` + `controls.streamGate` create the window — turn started, nothing
 * emitted yet — and the claim is asserted on which request carries which text.
 */

/**
 * A turn that actually REPLIES.
 *
 * 🔴 **Do not script a bare `stepStart/stepFinish/finish` here.** Measured 2026-08-05: an assistant turn
 * that produces no text and calls no tool makes the runner append an automated re-ground nudge —
 * *"Your last turn ended with no reply and no tool call…"* — as an extra user message on the FOLLOWING
 * request, and adds a `synthetic` entry to the transcript. That is correct behaviour and it is the
 * runner noticing a no-op turn, but it silently changes the message list every claim in this family
 * asserts on. Give each turn a real reply unless the no-op is the thing under test.
 */
const replyTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.textStart({ id }),
  LLMEvent.textDelta({ id, text }),
  LLMEvent.textEnd({ id }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

/**
 * Wait until the harness has seen `count` interactive requests.
 *
 * ⚠️ A busy-yield rather than a latch, and deliberately: a latch is one-shot, so a claim that has to
 * observe the START of the second *and* third turn cannot reuse one. Bounded by `runBounded` like
 * everything else, so a runner that never issues the request fails by name instead of spinning here.
 */
const waitForRequests = (harness: ReturnType<typeof makeRunnerHarness>, count: number) =>
  Effect.gen(function* () {
    while (harness.requests.length < count) yield* Effect.yieldNow
  })

describe("SessionRunnerLLM — steering", () => {
  test("steers an active provider turn with newly recorded prompts", async () => {
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({ turns: [replyTurn("text-1", "Working"), replyTurn("text-2", "Changed")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    const types = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        // The turn is in flight and has emitted nothing. Steer it now.
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Change direction" }) })

        // Opening the latch releases the in-flight turn AND every later one — a latch is one-shot, so
        // the steered continuation is not gated behind it. The whole exchange therefore completes
        // inside this one run, which is why there is no second `resume` here: adding one starts extra
        // turns and the request count goes to four.
        streamGate.open()
        yield* Fiber.join(first)

        return (yield* session.context(HARNESS_SESSION)).map((message) => message.type)
      }),
      "claim — steering an active turn",
    )

    expect(harness.requests).toHaveLength(2)
    // The load-bearing pair: the in-flight turn does NOT see the steer, and the next one does.
    expect(userTexts(harness.requests[0]!), "the turn already in flight must not be rewritten").toEqual([
      "Start working",
    ])
    expect(userTexts(harness.requests[1]!), "the steer reaches the NEXT turn").toEqual([
      "Start working",
      "Change direction",
    ])
    expect(types).toEqual(["user", "assistant", "user", "assistant"])
  })

  test("joins concurrent resume calls into one active provider run", async () => {
    // Two resumes while a turn is in flight must JOIN it, not start a second. This is the property the
    // whole steering family rests on — if a concurrent resume forked its own run, every claim about
    // "the next turn" would be about an arbitrary one of several.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({ turns: [replyTurn("text-once", "Once")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Run once" }), resume: false })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        const second = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        // Asserted BEFORE releasing: the second resume must not have issued its own request.
        expect(harness.requests, "a concurrent resume must join, not fork a second run").toHaveLength(1)

        streamGate.open()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — concurrent resumes join one run",
    )

    expect(harness.requests).toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Run once" },
      { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-once", text: "Once" }] },
    ])
  })

  test("coalesces multiple active steering prompts into one continuation turn", async () => {
    // TWO steers during one in-flight turn produce ONE continuation carrying both, not two turns. The
    // final `wake` is the load-bearing half: after coalescing, nothing may be left pending, so waking
    // the session must issue no further request. Without that check a runner that coalesced into one
    // turn and ALSO left a stray queued item would pass.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [replyTurn("text-1", "Working"), replyTurn("text-2", "Adjusted")],
    })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First steer" }) })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second steer" }) })

        streamGate.open()
        yield* Fiber.join(first)

        expect(harness.requests, "two steers coalesce into ONE continuation").toHaveLength(2)
        expect(userTexts(harness.requests[1]!)).toEqual(["Start working", "First steer", "Second steer"])

        // Nothing may remain pending after coalescing.
        yield* (yield* SessionExecution.Service).wake(HARNESS_SESSION)
        yield* Effect.yieldNow
      }),
      "claim — steers coalesce into one continuation",
    )

    expect(harness.requests, "a wake after coalescing must find nothing left to do").toHaveLength(2)
  })

  test("promotes queued inputs one at a time in FIFO order", async () => {
    // Two items queued during one in-flight turn must produce TWO further turns, in order — not one
    // turn carrying both (that is what STEERS do) and not the reverse order. The distinction between
    // queue and steer delivery is the whole point: a steer joins the next turn, a queued item gets its
    // own.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [replyTurn("t1", "One"), replyTurn("t2", "Two"), replyTurn("t3", "Three")],
    })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Queue first" }),
          delivery: "queue",
        })
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Queue second" }),
          delivery: "queue",
        })
        streamGate.open()
        yield* Fiber.join(first)
      }),
      "claim — queued inputs promote FIFO, one at a time",
    )

    expect(harness.requests, "each queued item gets its OWN turn").toHaveLength(3)
    expect(userTexts(harness.requests[0]!)).toEqual(["Start working"])
    expect(userTexts(harness.requests[1]!)).toEqual(["Start working", "Queue first"])
    expect(userTexts(harness.requests[2]!)).toEqual(["Start working", "Queue first", "Queue second"])
  })

  test("promotes steers before the next queued input", async () => {
    // The priority rule, and it needs both deliveries live at once: with two items already queued, a
    // steer arriving during the continuation must jump ahead of the remaining queued item. Steers are
    // course corrections to what is happening now; queued items are work to do next.
    //
    // Two gates rather than one, swapped between turns, because the claim has to inject at TWO distinct
    // moments — during turn 1 and again during turn 2.
    const firstGate = makeLatch()
    const secondGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [replyTurn("t1", "One"), replyTurn("t2", "Two"), replyTurn("t3", "Three"), replyTurn("t4", "Four")],
    })
    harness.controls.streamGate = firstGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* waitForRequests(harness, 1)
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Queue first" }),
          delivery: "queue",
        })
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Queue second" }),
          delivery: "queue",
        })

        harness.controls.streamGate = secondGate
        firstGate.open()
        yield* waitForRequests(harness, 2)
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Steer before next queued input" }),
        })
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Also steer before next queued input" }),
        })
        secondGate.open()
        yield* Fiber.join(first)
      }),
      "claim — steers jump ahead of queued input",
    )

    expect(harness.requests).toHaveLength(4)
    expect(userTexts(harness.requests[0]!)).toEqual(["Start working"])
    expect(userTexts(harness.requests[1]!)).toEqual(["Start working", "Queue first"])
    // The steers land BEFORE "Queue second" — that is the claim.
    expect(userTexts(harness.requests[2]!)).toEqual([
      "Start working",
      "Queue first",
      "Steer before next queued input",
      "Also steer before next queued input",
    ])
    expect(userTexts(harness.requests[3]!)?.at(-1), "the queued item follows the steers").toBe("Queue second")
  })

  test("promotes queued input after continuation ends", async () => {
    // A queued item must wait for the WHOLE exchange, not just the current request. Turn 1 calls a
    // tool, so turn 2 is its continuation — and the queued item must not cut in there. It gets turn 3.
    //
    // ⭐ That middle turn is why this claim exists and why its assertion looks redundant: requests 0
    // and 1 carry the SAME user text. A runner that promoted on "the request finished" instead of "the
    // exchange finished" would put the queued item into turn 2, and every other queue claim would still
    // pass.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        replyTurn("t2", "Continued"),
        replyTurn("t3", "Queued work"),
      ],
    })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Wait until continuation ends" }),
          delivery: "queue",
        })
        streamGate.open()
        yield* Fiber.join(first)
      }),
      "claim — queued input waits for the continuation",
    )

    expect(harness.requests).toHaveLength(3)
    expect(userTexts(harness.requests[0]!)).toEqual(["Start working"])
    expect(userTexts(harness.requests[1]!), "the continuation must NOT carry the queued item").toEqual([
      "Start working",
    ])
    expect(userTexts(harness.requests[2]!)).toEqual(["Start working", "Wait until continuation ends"])
  })

  test("promotes the first queued input when woken while idle", async () => {
    // Nothing is running. A queued item plus a wake must start a turn — otherwise queued work would sit
    // there until something else happened to resume the session, which is a silent stall rather than a
    // queue.
    const harness = makeRunnerHarness({ turns: [replyTurn("t1", "Picked it up")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Wait in queue" }),
          delivery: "queue",
          resume: false,
        })
        yield* (yield* SessionExecution.Service).wake(HARNESS_SESSION)
        // ⚠️ `waitForRequests`, not a bare `Effect.yieldNow`. A single tick is not a synchronisation
        // primitive for "the wake produced a request" — it happened to be enough while the wake path
        // reached the provider in one turn of the scheduler, and stopped being enough on 2026-08-13
        // when config resolution began folding the session folder's `novaclaw.json` (a bounded,
        // 1s-cached filesystem walk). The claim is that a wake promotes queued input, not that it
        // does so within one tick; the busy-yield is bounded by `runBounded`, so a runner that never
        // issues the request still fails by name rather than spinning.
        yield* waitForRequests(harness, 1)
      }),
      "claim — a wake while idle promotes the first queued input",
    )

    expect(harness.requests).toHaveLength(1)
    expect(userTexts(harness.requests[0]!)).toEqual(["Wait in queue"])
  })

  // Both durability claims are the same shape with one word changed, so they share a body. The point of
  // having BOTH is that queue and steer are stored and promoted differently — a runner that persisted
  // one and dropped the other would pass exactly half of this pair, which is why they are not merged
  // into a single parameterised claim with a shared assertion.
  const durableAcrossInterrupt = (delivery: "queue" | "steer", text: string) =>
    async function () {
      const streamStarted = makeLatch()
      const streamGate = makeLatch()
      const harness = makeRunnerHarness({ turns: [[], replyTurn("t2", "Resumed")] })
      harness.controls.streamStarted = streamStarted
      harness.controls.streamGate = streamGate

      await drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          const { db } = yield* Database.Service
          yield* session.prompt({
            sessionID: HARNESS_SESSION,
            prompt: Prompt.make({ text: "Interrupt current work" }),
            resume: false,
          })

          const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
          yield* Effect.promise(() => streamStarted.promise)
          yield* session.prompt({
            sessionID: HARNESS_SESSION,
            prompt: Prompt.make({ text }),
            ...(delivery === "queue" ? { delivery: "queue" as const } : {}),
          })

          // Interrupt with the input already accepted but the turn not yet settled — the window where
          // input is easiest to lose, because it belongs to a run that is about to fail.
          yield* session.interrupt(HARNESS_SESSION)
          expect(yield* Fiber.await(run), "an interrupted run FAILS").toMatchObject({ _tag: "Failure" })
          expect(harness.requests).toHaveLength(1)
          expect(
            yield* SessionInput.hasPending(db, HARNESS_SESSION, delivery),
            `${delivery} input must survive the interrupted run that accepted it`,
          ).toBe(true)

          const resumed = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
          yield* waitForRequests(harness, 2)
          streamGate.open()
          yield* Fiber.join(resumed)
        }),
        `claim — durable ${delivery} input survives interruption`,
      )

      expect(harness.requests).toHaveLength(2)
      expect(userTexts(harness.requests[0]!)).toEqual(["Interrupt current work"])
      expect(userTexts(harness.requests[1]!), "and reaches the turn after the resume").toEqual([
        "Interrupt current work",
        text,
      ])
    }

  test(
    "preserves durable queued input for a later wake after interruption",
    durableAcrossInterrupt("queue", "Run after interrupt"),
  )

  test(
    "preserves durable steering input for a later resume after interruption",
    durableAcrossInterrupt("steer", "Steer after interrupt"),
  )

  test("promotes queued input after steering continuation ends", async () => {
    // Queued BEFORE anything runs, so it is waiting from the start. It still must not join the first
    // turn — it gets its own, after that turn finishes. The delivery decides placement, not the
    // arrival time.
    const harness = makeRunnerHarness({ turns: [replyTurn("t1", "Steering"), replyTurn("t2", "Queued")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start steering" }),
          resume: false,
        })
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Queue for later" }),
          delivery: "queue",
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — queued input follows the steering continuation",
    )

    expect(harness.requests).toHaveLength(2)
    expect(userTexts(harness.requests[0]!), "an already-waiting queued item does not join turn 1").toEqual([
      "Start steering",
    ])
    expect(userTexts(harness.requests[1]!)).toEqual(["Start steering", "Queue for later"])
  })

  test("runs different sessions concurrently", async () => {
    // Two SESSIONS, one in flight. The second must start rather than queue behind the first — sessions
    // are the OS's threads, and a runner that serialised them would make one slow session block every
    // other, which is the property this claim exists to prevent.
    //
    // The cache-key assertion is the discriminating half: both requests are in flight at once AND are
    // keyed to their own session, so they cannot be sharing a prompt cache.
    const otherSession = SessionV2.ID.make("ses_harness_other")
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({ turns: [replyTurn("t1", "First"), replyTurn("t2", "Second")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* harness.seedSession(otherSession)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Run first" }), resume: false })
        yield* session.prompt({ sessionID: otherSession, prompt: Prompt.make({ text: "Run second" }), resume: false })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        const second = yield* session.resume(otherSession).pipe(Effect.forkChild)
        yield* waitForRequests(harness, 2)

        // Both in flight, before either is released.
        expect(harness.requests, "the second session must not wait for the first").toHaveLength(2)
        expect(harness.requests.map((request) => request.providerOptions?.openai?.promptCacheKey)).toEqual([
          HARNESS_SESSION,
          otherSession,
        ])

        streamGate.open()
        yield* Fiber.join(first)
        yield* Fiber.join(second)
      }),
      "claim — different sessions run concurrently",
    )

    expect(harness.requests).toHaveLength(2)
  })

  test("fans out one failed run and allows a later retry", async () => {
    // Two callers wait on one failing run. Both get the SAME failure — the run is shared, not
    // duplicated — and the session is left retryable afterwards.
    //
    // ⭐ Both halves matter and they pull opposite ways. Fanning out means a provider outage costs one
    // request rather than one per waiter. Staying retryable means the failure did not poison the
    // session: the next resume issues a fresh request. A runner that cached the failed run to "avoid
    // hammering the provider" would satisfy the first and break the second, leaving a session that can
    // never recover without being recreated.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ message: "Provider unavailable" }),
    })
    const harness = makeRunnerHarness({ turns: [replyTurn("t-retry", "Recovered")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate
    harness.controls.streamFailure = failure

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Retry after failure" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        const second = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.yieldNow

        expect(harness.requests, "the second waiter joins rather than issuing its own request").toHaveLength(1)

        streamGate.open()
        const [firstExit, secondExit] = yield* Effect.all([Fiber.await(first), Fiber.await(second)])
        expect(secondExit, "both waiters see the same outcome").toEqual(firstExit)

        // Clear the fault and retry: the session must still be usable.
        harness.controls.streamFailure = undefined
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a failed run fans out and stays retryable",
    )

    expect(harness.requests, "the failure did not poison the session").toHaveLength(2)
  })

  test("runs steering input accepted while the active provider turn fails", async () => {
    // A steer arrives during a turn that then FAILS. The steer was accepted, so it must survive the
    // failure and drive the next turn — the failure belongs to the provider call, not to the user's
    // input.
    //
    // ⭐ This is the pair to "preserves durable steering input … after interruption": there the turn is
    // cancelled, here it errors. Both must keep the input, and a runner that discarded pending input on
    // any non-clean exit would pass the queue claims and silently lose exactly the message a user sends
    // when they can see something going wrong.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ message: "Provider unavailable" }),
    })
    const harness = makeRunnerHarness({ turns: [replyTurn("t-recover", "Recovered")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate
    harness.controls.streamFailure = failure

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start working" }),
          resume: false,
        })

        const first = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Recover with this" }) })

        streamGate.open()
        expect(yield* Fiber.join(first).pipe(Effect.flip)).toBe(failure)

        // The fault clears; the steer that was accepted mid-failure now drives the next turn.
        harness.controls.streamFailure = undefined
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a steer accepted during a failing turn still runs",
    )

    expect(harness.requests).toHaveLength(2)
    expect(userTexts(harness.requests[1]!)).toEqual(["Start working", "Recover with this"])
  })
})
