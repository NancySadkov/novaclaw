import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — reasoning that has to SURVIVE, not merely render.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **Reasoning `providerMetadata` is a round-trip CARRIER, not decoration.** Anthropic signs a
 * reasoning block and rejects it later if the signature is missing; OpenAI's responses API hands back
 * encrypted reasoning state that must be returned verbatim to continue the thought. So dropping this
 * field does not degrade output quality — it makes the NEXT request invalid at the provider. That is
 * why the claim asserts it twice: once in the durable transcript after a replay, and once inside the
 * second turn's request, which is where the damage would actually show.
 */

describe("SessionRunnerLLM — reasoning round trip", () => {
  test("restores durable reasoning provider metadata in a second-turn request", async () => {
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.reasoningStart({ id: "reasoning-anthropic" }),
          LLMEvent.reasoningDelta({ id: "reasoning-anthropic", text: "Signed thought" }),
          LLMEvent.reasoningEnd({
            id: "reasoning-anthropic",
            providerMetadata: { anthropic: { signature: "sig_1" } },
          }),
          LLMEvent.reasoningStart({
            id: "reasoning-openai",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: null } },
          }),
          LLMEvent.reasoningDelta({ id: "reasoning-openai", text: "Encrypted thought" }),
          LLMEvent.reasoningEnd({
            id: "reasoning-openai",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
        // The re-ground nudge's continuation. Scripted rather than left empty: an unscripted turn is
        // now a named provider fault (`session-runner-errors.test.ts`), not silence.
        completeTurn("t2", "Done"),
        completeTurn("t3", "Continued"),
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Think first" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        // Durable, not merely live — rebuild from events before asserting.
        yield* harness.replayProjection(HARNESS_SESSION)
        const context = yield* session.context(HARNESS_SESSION)

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Continue" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return context
      }),
      "claim — reasoning metadata survives to the next request",
    )

    // ① Durable in the transcript, both providers' shapes intact.
    //
    // ⚠️ Filtered by the automated marker, not by role: this turn produces reasoning and nothing else,
    // so the runner appends its "no reply" nudge — as a USER message, which a role filter would keep.
    // (Same trap as the reasoning fragment claim; see session-runner-fragments.test.ts.)
    // ⚠️ TWO exclusions are needed, not one. The nudge arrives as a `user` message carrying the
    // `[Automated NovaClaw …]` marker AND as a companion `synthetic` transcript entry, which has no
    // marker text at all. Filtering by marker alone leaves the synthetic behind; filtering by role
    // alone leaves the user-role nudge. Both, or the array length is wrong either way.
    const human = (messages: readonly unknown[]) =>
      (messages as Array<{ type: string; text?: string }>).filter(
        (m) => (m.type === "user" || m.type === "assistant") && !String(m.text ?? "").startsWith("[Automated NovaClaw"),
      )
    expect(human(context)).toMatchObject([
      { type: "user", text: "Think first" },
      {
        type: "assistant",
        content: [
          { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
          {
            type: "reasoning",
            text: "Encrypted thought",
            providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
          },
        ],
      },
      // The nudge's own reply — this turn produced reasoning and no text, so the runner asked for one.
      { type: "assistant", finish: "stop" },
    ])

    // ② And carried back OUT on the next turn — the half that actually breaks a provider if dropped.
    expect(harness.requests[1]?.messages[1]?.content).toEqual([
      { type: "reasoning", text: "Signed thought", providerMetadata: { anthropic: { signature: "sig_1" } } },
      {
        type: "reasoning",
        text: "Encrypted thought",
        providerMetadata: { openai: { itemId: "rs_1", reasoningEncryptedContent: "encrypted-state" } },
      },
    ])
  })
})
