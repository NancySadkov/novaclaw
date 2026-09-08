import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — the two provider-stream orderings the projector must REFUSE.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). They are driven entirely by scripted events — no agent config, no
 * system-context knobs, no timing — which is what makes them cheap.
 *
 * ⚠️ Both assert a **defect**, not a failure: the runner dies with a string rather than failing with a
 * typed error, so they are caught with `Effect.catchDefect`. That is carried across verbatim because it
 * IS the claim — a malformed stream is a programmer error in the projector, not a condition callers are
 * expected to handle.
 *
 * 🔴 **Two of these four could not be landed for a day, and the reason is worth reading before adding
 * another.** They failed with the drain reporting success while writing no assistant message, while an
 * apparently identical probe of the same script passed. The difference turned out to be the PROMPT
 * TEXT: `"Two blocks"` triggers a utility provider pass that `"Go"` does not, that pass carries **no
 * system prompt at all**, and the harness's marker-based classifier could not match an empty string —
 * so it landed in the interactive log and **ate the scripted turn**, leaving the real turn an empty
 * stream. The classifier now tests POSITIVELY for the agent system prompt, so any utility pass falls
 * out by construction. See `fixture/runner-harness.ts` and  → S3.
 */

describe("SessionRunnerLLM — stream projection", () => {
  test("rejects duplicate streamed text starts", async () => {
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.textStart({ id: "text-1" }), LLMEvent.textStart({ id: "text-1" })]],
    })

    const defect = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        return yield* session.resume(HARNESS_SESSION).pipe(Effect.catchDefect(Effect.succeed))
      }),
      "claim — duplicate text start rejected",
    )

    expect(defect).toBe("Duplicate text start: text-1")
  })

  test("rejects malformed streamed tool input ordering", async () => {
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.toolInputDelta({ id: "call-1", name: "read", text: "{}" })]],
    })

    const defect = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        return yield* session.resume(HARNESS_SESSION).pipe(Effect.catchDefect(Effect.succeed))
      }),
      "claim — tool input delta before start rejected",
    )

    expect(defect).toBe("Tool input delta before start: call-1")
  })

  test("keeps interleaved assistant text blocks separate", async () => {
    // Two text blocks opened before either closes. The projector must keep them distinct and in
    // start-order rather than concatenating deltas into whichever block is open.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-1" }),
          LLMEvent.textStart({ id: "text-2" }),
          LLMEvent.textDelta({ id: "text-1", text: "First" }),
          LLMEvent.textDelta({ id: "text-2", text: "Second" }),
          LLMEvent.textEnd({ id: "text-1" }),
          LLMEvent.textEnd({ id: "text-2" }),
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
          prompt: Prompt.make({ text: "Two blocks" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — interleaved text blocks stay separate",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Two blocks" },
      {
        type: "assistant",
        content: [
          { type: "text", id: "text-1", text: "First" },
          { type: "text", id: "text-2", text: "Second" },
        ],
      },
    ])
  })

  test("transitions streamed raw tool input to parsed called input", async () => {
    // Raw input streamed in fragments, then the parsed call. The stored content must carry the PARSED
    // input, not the accumulated JSON text.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolInputStart({ id: "call-parsed", name: "web_search" }),
          LLMEvent.toolInputDelta({ id: "call-parsed", name: "web_search", text: '{"query":"hello"}' }),
          LLMEvent.toolInputEnd({ id: "call-parsed", name: "web_search" }),
          LLMEvent.toolCall({
            id: "call-parsed",
            name: "web_search",
            input: { query: "hello" },
            providerExecuted: true,
          }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Call provider tool" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — raw tool input becomes parsed called input",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Call provider tool" },
      {
        type: "assistant",
        content: [{ type: "tool", id: "call-parsed", state: { status: "error", input: { query: "hello" } } }],
      },
    ])
  })

  test("projects reasoning and tool events without executing or continuing tools", async () => {
    // One dense turn carrying every provider-side content kind at once: reasoning, a PROVIDER-executed
    // tool that errored, and another that returned mixed text+file content — plus usage.
    //
    // ⭐ "Without executing or continuing" is the claim, and it is invisible in the transcript. Both
    // tool calls are `providerExecuted`, so the runner must PROJECT their results rather than run
    // anything locally, and must not start a continuation turn to deliver them. The single interactive
    // request is what proves it: a runner that treated a provider-executed call like a local one would
    // produce the same content and one extra turn, having tried to execute a tool it does not own.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-1" }),
          LLMEvent.reasoningDelta({ id: "reasoning-1", text: "Think" }),
          LLMEvent.reasoningEnd({ id: "reasoning-1" }),
          LLMEvent.toolInputStart({ id: "call-error", name: "write" }),
          LLMEvent.toolInputDelta({ id: "call-error", name: "write", text: '{"path":"README.md"}' }),
          LLMEvent.toolInputEnd({ id: "call-error", name: "write" }),
          LLMEvent.toolCall({
            id: "call-error",
            name: "write",
            input: { path: "README.md" },
            providerExecuted: true,
          }),
          LLMEvent.toolError({ id: "call-error", name: "write", message: "Denied" }),
          LLMEvent.toolResult({ id: "call-error", name: "write", result: { type: "error", value: "Denied" } }),
          LLMEvent.toolCall({
            id: "call-provider",
            name: "web_search",
            input: { query: "hello" },
            providerExecuted: true,
            providerMetadata: { fake: { source: "provider" } },
          }),
          LLMEvent.toolResult({
            id: "call-provider",
            name: "web_search",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Hello" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "hello.png" },
              ],
            },
            providerExecuted: true,
            providerMetadata: { fake: { source: "provider" } },
          }),
          LLMEvent.stepFinish({
            index: 0,
            reason: "tool-calls",
            usage: {
              inputTokens: 10,
              nonCachedInputTokens: 8,
              outputTokens: 4,
              reasoningTokens: 1,
              cacheReadInputTokens: 2,
            },
          }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Use tools" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — provider-executed tools are projected, not run",
    )

    expect(harness.requests, "no continuation turn — nothing local was owed").toHaveLength(1)
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toEqual(["echo", "defect"])
    expect(harness.executions, "no local tool ran").toEqual([])
    expect(context).toMatchObject([
      { type: "user", text: "Use tools" },
      {
        type: "assistant",
        finish: "tool-calls",
        // Usage is projected too, and `input` is the NON-CACHED count — the cached read is reported
        // separately rather than folded in, or a cache hit would look like a larger prompt.
        tokens: { input: 8, output: 3, reasoning: 1, cache: { read: 2, write: 0 } },
        content: [
          { type: "reasoning", id: "reasoning-1", text: "Think" },
          {
            type: "tool",
            id: "call-error",
            name: "write",
            state: { status: "error", input: { path: "README.md" }, error: { type: "unknown", message: "Denied" } },
          },
          {
            type: "tool",
            id: "call-provider",
            name: "web_search",
            provider: { executed: true, metadata: { fake: { source: "provider" } } },
            state: {
              status: "completed",
              input: { query: "hello" },
              structured: {},
              content: [
                { type: "text", text: "Hello" },
                { type: "file", mime: "image/png", uri: "data:image/png;base64,aGVsbG8=", name: "hello.png" },
              ],
            },
          },
        ],
      },
    ])
  })
})
