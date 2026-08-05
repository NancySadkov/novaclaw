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
 * out by construction. See `fixture/runner-harness.ts` and todo/v0.2.0-prep.md → S3.
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
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Two blocks" }), resume: false })
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
})
