import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import {
  HARNESS_SESSION,
  SYSTEM_CONTEXT_REMOVED_MESSAGE,
  drive,
  makeRunnerHarness,
} from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — what happens to durable system context when the world changes UNDER a session.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). These are the first ported claims that need the world to change
 * *between* turns, which is what `harness.controls` exists for.
 *
 * ⚠️ **These do NOT assert the whole system array, and the reason is now a rule.** The old tests pinned
 * it to a single element (`["Initial context"]`). The request now carries several parts — a base
 * persona, the agent's system, the project-scope guidance — none of which existed when these were
 * written. So each claim asserts the part it is ABOUT and ignores the rest; see
 * `session-runner-agent.test.ts` for the same treatment and the measurement behind it.
 */

/** The durable-context part, located by content rather than by index. */
const durableContext = (parts: readonly { text: string }[] | undefined) =>
  (parts ?? []).map((part) => part.text).find((text) => text.startsWith("Initial context") || text.startsWith("Replacement context"))

describe("SessionRunnerLLM — durable system context", () => {
  test("admits removed context as a chronological System message", async () => {
    // A producer that disappears must be ANNOUNCED in the transcript, not silently dropped —
    // ruling 2's "an unavailable subsystem names itself" at the context layer.
    //
    // 🔴 **The old expectation was `["user","user","system"]` and the runner now says
    // `["user","user","user"]` — that is a BEHAVIOUR CHANGE, not a regression, and it is why this claim
    // had to be re-derived rather than copied.** Measured: the notice is still admitted chronologically
    // and still names the source, but it is **lowered to a `user` role on the wire** and carries an
    // explicit `[Automated NovaClaw check — not a message from your user.]` prefix. Internally it is
    // still a system message (`session.messages()` reports type `system`); only the wire role changed.
    // That matters beyond this test: **a provider that rejects mid-conversation system roles would
    // otherwise break every context notice**, and the prefix is what stops the model reading an
    // automated notice as something its user said.
    //
    // So this asserts what the runner actually guarantees — the notice arrives, names the source, and
    // is framed as automated — rather than a wire role that is an implementation choice.
    const harness = makeRunnerHarness()

    const messages = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemRemoved = true

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.messages({ sessionID: HARNESS_SESSION })
      }),
      "claim — removed context becomes a System message",
    )

    const second = harness.requests[1]
    expect(second?.messages, "both user turns plus the removal notice").toHaveLength(3)
    const notice = JSON.stringify(second?.messages.at(-1)?.content)
    expect(notice, "the notice must name the source that went away").toContain(SYSTEM_CONTEXT_REMOVED_MESSAGE)
    expect(notice, "and must be framed as automated, not as something the user said").toContain(
      "not a message from your user",
    )
    // It is a SYSTEM message in the session's own record even though the wire lowers it to `user`.
    expect((messages as Array<{ type: string }>).filter((message) => message.type === "system")).toHaveLength(1)
    expect(messages).toHaveLength(3)
  })

  test("preserves the baseline while context is temporarily unavailable", async () => {
    // Three turns: normal, unavailable, then a CHANGED baseline. The baseline must survive ALL THREE.
    //
    // ⚠️ The third turn is the counter-intuitive one and it is the claim, not a bug: after
    // `systemBaseline` genuinely changes, the request still carries "Initial context". A baseline is
    // established ONCE; later changes are admitted as chronological System messages instead of
    // rewriting the prompt prefix. (I first asserted the opposite here — that a real change is picked
    // up — which contradicts this claim's own title, and the runner was right.) That design is what
    // keeps the prompt prefix cacheable across a session.
    const harness = makeRunnerHarness()

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemUnavailable = true
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemUnavailable = false
        harness.controls.systemBaseline = "Replacement context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — baseline survives an unavailable window",
    )

    expect(harness.requests).toHaveLength(3)
    expect(durableContext(harness.requests[0]?.system), "turn 1 carries the baseline").toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[1]?.system),
      "an unavailable producer must not destroy the established baseline",
    ).toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[2]?.system),
      "a changed baseline must NOT rewrite the established prompt prefix",
    ).toMatch(/^Initial context/)
  })
})
