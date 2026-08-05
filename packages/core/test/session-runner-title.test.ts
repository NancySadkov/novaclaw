import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — the post-drain auto-title, and the token-budget controller it shares.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). This is the first ported claim to use the harness's `titleTurns`
 * channel — the out-of-band title probe that `OUT_OF_BAND` has been routing away from the interactive
 * log since the second slice.
 */

describe("SessionRunnerLLM — auto-title", () => {
  test("auto-titles a reasoning model through the shared token-budget controller", async () => {
    // A reasoning model can spend its whole title budget thinking and emit no title at all. The shared
    // budget controller cuts the oversized reasoning at a checkpoint and CONTINUES the completion
    // rather than accepting an empty result — so the session still gets a name.
    //
    // ⭐ Two assertions carry the claim beyond "a title appeared". The first title request must state
    // the reasoning budget in its system prompt, and the second must set `continue_final_message`,
    // which is what makes the second call a continuation of the first rather than a fresh attempt.
    // Without that flag the model would restart its thinking and could overrun again — the controller
    // would be a retry loop wearing a budget's name.
    const harness = makeRunnerHarness({
      turns: [completeTurn("answer", "I found the parser issue.")],
      titleTurns: [
        // The first utility call gets stuck reasoning and produces no title.
        [LLMEvent.reasoningDelta({ id: "title-reasoning", text: "r".repeat(1_000) })],
        [
          LLMEvent.textDelta({ id: "title", text: "Parser failure investigation" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        ],
      ],
    })

    const title = await drive(
      harness,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const session = yield* SessionV2.Service
        // Auto-title only runs while the title is still a creation default.
        yield* db
          .update(SessionTable)
          .set({ title: "New session" })
          .where(eq(SessionTable.id, HARNESS_SESSION))
          .run()
          .pipe(Effect.orDie)

        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Investigate parser failures" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return (yield* session.get(HARNESS_SESSION)).title
      }),
      "claim — a reasoning model still gets titled",
    )

    expect(title).toBe("Parser failure investigation")
    expect(harness.titleRequests, "the controller took a second, continuing call").toHaveLength(2)
    expect(JSON.stringify(harness.titleRequests[0]?.system)).toContain("reasoning budget of about 128 tokens")
    expect(
      harness.titleRequests[1]?.http?.body?.["continue_final_message"],
      "the second call CONTINUES the first — otherwise the controller is just a retry loop",
    ).toBe(true)
    // And the title work stayed out of the interactive log.
    expect(harness.requests).toHaveLength(1)
  })
})
