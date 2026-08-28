import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { LLMError, LLMEvent, TransportReason } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — hosted (provider-executed) tools that never come back.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **Why this family exists at all.** A hosted tool is executed by the PROVIDER, so we only ever learn
 * its result by being told. If the stream ends — cleanly, with an error, or by dying — while a hosted
 * call is still open, nothing will ever resolve it. The runner must therefore close it ITSELF, durably,
 * as an error. Anything less leaves a tool call `running` forever in a transcript that is otherwise
 * complete, and every later turn re-sends that dangling call to the model.
 *
 * Each claim replays the projection afterwards: the failure has to be reconstructible from events
 * alone, not merely present in memory. A tool closed only in the live projection would come back
 * `running` on the next process.
 */

const providerUnavailable = () =>
  new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider unavailable" }) })

const hostedCall = (id: string) =>
  LLMEvent.toolCall({ id, name: "web_search", input: { query: "effect" }, providerExecuted: true })

describe("SessionRunnerLLM — hosted tool results", () => {
  test("replays durable provider-executed tool results inline in a second-turn request", async () => {
    // A hosted call that DID return must be replayed to the provider exactly as it arrived — call and
    // result adjacent, inside the assistant message, with both sides' providerMetadata intact.
    //
    // ⭐ The metadata is a round-trip carrier here just as it is for reasoning: OpenAI keys the hosted
    // item by `itemId` and Anthropic tags the result block type. Dropping either does not degrade the
    // answer, it makes the next request unrecognisable to the provider that produced it.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({
            id: "hosted-search",
            name: "web_search",
            input: { query: "Effect" },
            providerExecuted: true,
            providerMetadata: { openai: { itemId: "hosted-search" } },
          }),
          LLMEvent.toolResult({
            id: "hosted-search",
            name: "web_search",
            result: { type: "json", value: [{ title: "Effect" }] },
            providerExecuted: true,
            providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        [],
      ],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Search first" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        // Durable, not merely live: the replay is what proves the metadata survives a process boundary.
        yield* harness.replayProjection(HARNESS_SESSION)

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — hosted results replay inline with metadata",
    )

    expect(harness.requests[1]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
    expect(harness.requests[1]?.messages[1]?.content).toMatchObject([
      {
        type: "tool-call",
        id: "hosted-search",
        name: "web_search",
        input: { query: "Effect" },
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "hosted-search" } },
      },
      {
        type: "tool-result",
        id: "hosted-search",
        name: "web_search",
        result: { type: "json", value: [{ title: "Effect" }] },
        providerExecuted: true,
        providerMetadata: { anthropic: { blockType: "web_search_tool_result" } },
      },
    ])
  })
})

describe("SessionRunnerLLM — hosted tools left unresolved", () => {
  test("durably fails a hosted tool when its provider errors before returning a result", async () => {
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          hostedCall("call-hosted-provider-error"),
          LLMEvent.providerError({ message: "Provider unavailable" }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail hosted tool durably" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — hosted tool closed when the provider errors",
    )

    expect(harness.requests, "the turn must not be retried").toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Fail hosted tool durably" },
      { type: "assistant", content: [{ type: "tool", id: "call-hosted-provider-error", state: { status: "error" } }] },
    ])
  })

  test("durably fails a hosted tool left unresolved at normal provider EOF", async () => {
    // The quietest case and the easiest to get wrong: the stream ends NORMALLY with the call still
    // open. There is no error to react to, so a runner that only closes hosted calls on failure paths
    // leaves this one running forever.
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-eof")]],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail hosted tool at EOF" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        yield* harness.replayProjection(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — hosted tool closed at normal EOF",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Fail hosted tool at EOF" },
      { type: "assistant", content: [{ type: "tool", id: "call-hosted-eof", state: { status: "error" } }] },
    ])
  })

  test("durably fails a hosted tool left unresolved by a raw provider stream failure", async () => {
    // The stream DIES rather than reporting an error event. The turn surfaces the raw failure to the
    // caller AND still closes the dangling hosted call.
    const failure = providerUnavailable()
    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([LLMEvent.stepStart({ index: 0 }), hostedCall("call-hosted-raw-failure")]),
          Stream.fail(failure),
        ),
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail hosted tool on raw failure" }),
          resume: false,
        })
        expect(yield* session.resume(HARNESS_SESSION).pipe(Effect.flip)).toBe(failure)
        yield* harness.replayProjection(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — hosted tool closed on a raw stream failure",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Fail hosted tool on raw failure" },
      {
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Provider unavailable" },
        content: [{ type: "tool", id: "call-hosted-raw-failure", state: { status: "error" } }],
      },
    ])
  })
})
