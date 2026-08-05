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
 * ⏳ **Two sibling claims from this family are deliberately NOT here** — "keeps interleaved assistant
 * text blocks separate" and "transitions streamed raw tool input to parsed called input". Both were
 * written, both failed with the drain reporting success while writing no assistant message, and **an
 * apparently identical probe of the same scripts passes**, so the difference is not understood yet.
 * They stay `spec` rather than being landed on a guess. See todo/v0.2.0-prep.md → S3.
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
})
