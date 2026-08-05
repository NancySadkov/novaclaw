import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
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
})
