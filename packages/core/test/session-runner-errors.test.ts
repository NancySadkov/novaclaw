import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — how a provider error becomes a durable, terminal assistant failure.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). The pair differs in exactly one thing — whether the error arrives
 * after a step has started or before any step at all — and that is the point: **the projection must not
 * depend on having an open step to attach the failure to.** An error before `stepStart` is the case a
 * projector written around "close the current step" gets wrong.
 *
 * ⚠️ `finish: "error"` is the claim, not an incidental field. A drain that swallowed the error and
 * settled normally would still write an assistant message, so asserting only its presence would pass on
 * the bug — ruling 2's *a fault is never described falsely*, at the projection layer.
 */

describe("SessionRunnerLLM — provider errors", () => {
  test("projects provider errors as terminal assistant step failures", async () => {
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail durably" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — provider error is a terminal assistant failure",
    )

    expect(harness.requests, "a provider error must not be retried into a second turn").toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Fail durably" },
      { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
    ])
  })

  test("projects provider errors emitted before assistant step start", async () => {
    // No `stepStart` at all — the error is the first event on the stream.
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.providerError({ message: "Provider unavailable" })]],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail before step" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — provider error before any step start",
    )

    expect(harness.requests).toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Fail before step" },
      { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
    ])
  })
})
