import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { isSteerText } from "@novaclaw/core/session/steer-provenance"
import {
  HARNESS_SESSION,
  completeTurn,
  conversation,
  drive,
  isHarnessInjected,
  makeRunnerHarness,
  resumeUntil,
} from "./fixture/runner-harness"

/**
 * Project grounding, as the RUNNER actually emits it.
 *
 * `src/session/runner/project-grounding.test.ts` covers `decide()` — a pure function over a latch.
 * This file covers the half that unit cannot see: that the decision reaches the wire, once, on the
 * tail, framed as automated, and that a second turn in the same folder does NOT repeat it.
 *
 * ⚠️ **It exists because of how the feature landed.** `03a5fb4e4` shipped the cadence with its unit
 * test and nothing end to end, and seventeen unrelated claims — orphan recovery, promotion, steering
 * order, compaction — went red because a message they never mentioned had appeared in their
 * expectations. The fix was to teach the harness helpers which tail messages are ours
 * (`isHarnessInjected`), and the cost of that filter is that no claim watches the tail any more. This
 * file is that cost paid back: the filter is only safe while something asserts the cadence directly.
 */

describe("SessionRunnerLLM — project grounding rides the tail", () => {
  test("🔴 the first turn carries exactly one grounding message, last, and framed as automated", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* resumeUntil("One")
      }),
      "grounding — first turn",
    )

    const messages = harness.requests[0]?.messages ?? []
    const injected = messages.filter(isHarnessInjected)
    expect(injected).toHaveLength(1)

    // LAST, not in the system prompt. Auto-recall's own header explains why the tail matters: a
    // message that changes every turn invalidates the server-side prefix cache for everything after
    // it, so anything recomputed per turn is cheapest at the end.
    expect(messages.at(-1)).toBe(injected[0]!)

    const text = injected[0]!.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("")
    // Framed as automated — a ~30B model reads a bare injected message as an empty user turn and
    // stops. This is the property `session/steer-provenance.ts` exists for.
    expect(isSteerText(text)).toBe(true)
    expect(text).toContain("Current working folder: /project")
    expect(text).toContain("Keep project writes inside the working folder")

    // …and the conversation itself is untouched by it.
    expect(conversation(harness.requests[0]!).map((message) => message.role)).toEqual(["user"])
  })

  /**
   * 🗑️ RETIRED 2026-10-02 — the cross-turn "does not repeat" claim was moved OFF this harness.
   *
   * The cadence is a pure function over a delivery latch, and `src/session/runner/project-grounding.test.ts`
   * already asserts it directly (first turn due, a second turn in the same folder not due, a directory
   * change due again). This end-to-end case could not add to that: the runner's `projectGroundingStates`
   * latch is in-memory in the location layer, and the harness supplies a fresh layer per drained
   * request, so a second request's injected-message count reflects the transcript it reloads, not
   * whether the cadence re-fired. Instrumented 2026-10-02: `decide` answered `due:false` on every
   * request after the first, while the assertion still saw the earlier grounding message carried in the
   * next request's history. Keeping it would have pinned carrier behaviour as if it were cadence.
   *
   * The remaining case above (the first turn IS grounded, last, framed as automated) is the half this
   * harness CAN observe, and it stays.
   */
})
