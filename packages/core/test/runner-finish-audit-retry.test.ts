// RUN AND PASSING (5/5), in the tree beside runner-finish-audit.test.ts.
//
// Why this exists: the fold fix (audit-verdict-complete.patch, hunk 1) makes the exit audit retry ONCE
// when the judge's reply is unusable, with `reasoningBudget: 0`. That adds a second utility-model call
// on a failure path, and nothing else in the suite covers it.
//
// The two assertions that matter most are the BOUND (exactly one retry — never a loop) and the
// no-retry-when-the-reply-is-good case (the retry must not fire on the normal path).
//
// Both unknowns the first draft flagged are now settled by running it: `harness.utilityRequests` does
// count the audit's judge call (the length assertions hold), and an unaccepted exit leaves `result`
// as the string it was called with rather than the accepted one, so "not the accepted result" is a
// real assertion rather than a hedge.
//
// What this still does NOT prove: that the retry recovers a genuine verdict from a live model. The
// judge's replies here are scripted; no real provider was involved.

import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { FinishAudit } from "@novaclaw/core/session/runner/finish-audit"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

const exitTurn = (result: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "exit-call", name: "exit", input: { result } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

/**
 * `utilityTurns` is consumed with `shift()` (runner-harness.ts:455), so the Nth entry answers the Nth
 * out-of-band request — which is the audit's judge call.
 *
 * An UNPARSEABLE reply ("perhaps") is used rather than a silent one on purpose: a scripted turn that
 * produces no text at all trips the runner's no-op re-ground path, and the fixture's own header warns
 * that this inflates request counts and breaks transcript assertions. "perhaps" reaches the same branch
 * — `FinishAudit.verdict` returns "unknown" either way — without that machinery in the way.
 */
const runAudit = async (judgeReplies: string[]) => {
  const harness = makeRunnerHarness({
    withExitTool: true,
    turns: [exitTurn("implemented and verified"), completeTurn("continued", "Continued after rejection")],
    utilityTurns: judgeReplies.map((reply) => completeTurn("audit", reply)),
  })
  let transcript: { type: string; text?: string }[] = []
  let result: unknown
  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Do the work, then exit." }),
        resume: false,
      })
      if (judgeReplies.at(-1) === "YES") yield* session.resume(HARNESS_SESSION)
      else {
        const events = yield* EventV2.Service
        const continued = yield* events.subscribe(SessionEvent.Text.Ended).pipe(
          Stream.filter((event) => event.data.sessionID === HARNESS_SESSION && event.data.text.includes("Continued after rejection")),
          Stream.take(1), Stream.runHead, Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const running = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Fiber.join(continued)
        yield* session.interrupt(HARNESS_SESSION)
        yield* Fiber.await(running)
      }
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
      result = (yield* session.get(HARNESS_SESSION)).result
    }),
    `exit completion audit retry (${judgeReplies.join(" then ")})`,
  )
  return { harness, transcript, result }
}

describe("an unusable audit reply is retried, exactly once", () => {
  test("an unparseable reply is retried, and a YES on the retry completes the exit", async () => {
    const { harness, result } = await runAudit(["perhaps", "YES"])
    expect(harness.utilityRequests).toHaveLength(2) // the retry happened
    expect(result).toBe("implemented and verified")
  })

  test("the retry is BOUNDED — two unusable replies never become a loop", async () => {
    const { harness, result } = await runAudit(["perhaps", "maybe"])
    expect(harness.utilityRequests).toHaveLength(2) // two judge calls, not three, not thirty
    expect(result).not.toBe("implemented and verified")
  })

  test("a good reply is not retried at all", async () => {
    const { harness, result } = await runAudit(["YES"])
    expect(harness.utilityRequests).toHaveLength(1)
    expect(result).toBe("implemented and verified")
  })

  test("a considered NO is not retried either — only an unusable reply is", async () => {
    const { harness } = await runAudit(["NO"])
    expect(harness.utilityRequests).toHaveLength(1)
  })

  test("reason() names WHY a reply could not be read", () => {
    expect(FinishAudit.reason("")).toBe("empty")
    expect(FinishAudit.reason("perhaps")).toBe("unparsed")
  })
})
