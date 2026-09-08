import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { InvalidProviderOutputReason, LLMError, LLMEvent, TransportReason } from "@novaclaw/llm"
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

  test("does not recover context overflow after durable assistant output", async () => {
    // An overflow reported AFTER the assistant has already produced durable text is not recoverable by
    // compaction — the turn is half-spoken. Compacting and retrying would either duplicate the partial
    // answer or discard it, and both are worse than reporting the failure with the partial preserved.
    //
    // ⭐ The single request is the claim. The identical scenario WITHOUT prior output compacts and
    // retries (see the overflow claims); what flips the behaviour is that something durable was already
    // said.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-partial" }),
          LLMEvent.textDelta({ id: "text-partial", text: "Partial" }),
          LLMEvent.textEnd({ id: "text-partial" }),
          LLMEvent.providerError({ message: "prompt too long", classification: "context-overflow" }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail after output" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — no overflow recovery once output is durable",
    )

    expect(harness.requests, "no compaction, no retry — the turn is half-spoken").toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Fail after output" },
      {
        type: "assistant",
        finish: "error",
        error: { message: "prompt too long" },
        content: [{ type: "text", text: "Partial" }],
      },
    ])
  })

  test("accepts a malformed stream tail as broken context and continues without replaying the request", async () => {
    // The provider's SSE frame is truncated mid-reply. The partial text is USABLE and is kept, the turn
    // is marked `broken` rather than `error`, and the runner continues — telling the model that its
    // previous reply ended abruptly instead of silently re-sending the same request.
    //
    // ⭐ "Without replaying the request" is the load-bearing half. A runner that retried the identical
    // request would discard usable output and pay for the whole turn again; on a small local model,
    // truncated frames are common enough that retrying is a real cost, not a corner case.
    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text-broken" }),
            LLMEvent.textDelta({ id: "text-broken", text: "Usable partial" }),
          ]),
          Stream.fail(
            new LLMError({
              module: "test",
              method: "stream",
              reason: new InvalidProviderOutputReason({ message: "truncated SSE frame" }),
            }),
          ),
        ),
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-recovered" }),
          LLMEvent.textDelta({ id: "text-recovered", text: "Recovered" }),
          LLMEvent.textEnd({ id: "text-recovered" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Survive a broken reply" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — a malformed tail becomes broken context, not a replay",
    )

    expect(harness.requests).toHaveLength(2)
    expect(harness.requests[1]?.messages.at(-1)?.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text", text: expect.stringContaining("previous provider reply ended") }),
      ]),
    )
    expect(context).toMatchObject([
      { type: "user", text: "Survive a broken reply" },
      { type: "assistant", finish: "broken", content: [{ type: "text", text: "Usable partial" }] },
      { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
    ])
  })

  test("projects raw provider stream failures as terminal assistant step failures", async () => {
    // The stream dies before emitting anything at all. The failure reaches the caller AND is recorded
    // as a terminal assistant failure that survives a projection replay — a session whose provider died
    // must still be able to say what happened after a restart.
    const failure = new LLMError({
      module: "test",
      method: "stream",
      reason: new TransportReason({ message: "Provider unavailable" }),
    })
    const harness = makeRunnerHarness({ turns: [Stream.fail(failure)] })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail raw stream durably" }),
          resume: false,
        })
        expect(yield* session.resume(HARNESS_SESSION).pipe(Effect.flip)).toBe(failure)
        yield* harness.replayProjection(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — a raw stream failure is durable",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Fail raw stream durably" },
      { type: "assistant", finish: "error", error: { type: "unknown", message: "Provider unavailable" } },
    ])
  })

  test("reports an empty provider response as a terminal assistant failure", async () => {
    // 🔴 THE REGRESSION CHECK FOR A CONFIRMED DEFECT (roadmap item, fixed in the same commit). The
    // provider returns a stream that SUCCEEDS having emitted nothing. Before the fix this fell through
    // every branch in the runner's post-stream chain — all of which are gated on a stream FAILURE — and
    // the turn ended silently: one request, no assistant row, and the drain settling `Exit Success`
    // with a transcript holding only the user's message.
    //
    // ⭐ The assistant message is the claim, not the request count. Nothing above the drain could see
    // this: R5's retry/stop UI, the execution-attempt ledger and an agent awaiting `exit()` all read
    // "success" and observe the user's turn simply not answered — no fault named, nothing to retry.
    // Ruling 2 broken at the drain itself.
    //
    // ⚠️ This is also why a claim asserting on request COUNT must script a real response: an empty
    // stream is not "one request and stop", it is one request and a FAULT.
    const harness = makeRunnerHarness({ turns: [[]] })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Answer me" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — an empty provider response is a named fault",
    )

    expect(harness.requests, "the empty stream is not retried into a second turn").toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Answer me" },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "The provider returned an empty response" },
      },
    ])
  })
})
