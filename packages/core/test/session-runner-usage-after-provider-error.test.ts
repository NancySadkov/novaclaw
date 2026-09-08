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
 * **A18.3 — when a provider error arrives AFTER tokens have already streamed, does the settlement
 * record the usage that was really spent?**
 *
 * ⭐ **This file is an ANSWER, not a fix.** The item asks what happens, and nobody had measured it;
 * a change made before the behaviour is pinned would have no baseline to be judged against. So each
 * case asserts what the runner does TODAY and says, in place, whether that is the desired end state.
 *
 * **The measured answer: no. Usage spent before a provider error is discarded entirely** — the
 * session's token totals do not move, and neither does anything downstream of `Step.Ended` (the
 * EEVDF scheduler charge, the `ctx_pressure` tripwire, the live `ps` token counts). This is true
 * even in the case where the provider DID report its usage: a `step-finish` frame carrying real
 * numbers, followed by an error, is settled as if the numbers never arrived.
 *
 * The cause is one conjunct in `runner/llm.ts`:
 *
 * ```ts
 * const stepSettlement = publisher.stepSettlement()
 * if (stepSettlement && !publisher.hasProviderError()) { …publish Step.Ended… }
 * ```
 *
 * `hasProviderError()` latches on the `provider-error` event and never clears, so the settlement
 * block is skipped wholesale — and `Step.Ended` is the ONLY event whose projection calls
 * `applyUsage`. `Step.Failed`, which a provider error does publish, folds no tokens.
 *
 * ⭐ **That explanation is MEASURED, not read off the source.** Deleting the
 * `&& !publisher.hasProviderError()` conjunct and re-running case 1 makes the session row report
 * exactly the numbers the provider sent — `{input: 900, output: 160, reasoning: 40, cacheRead: 100}`
 * instead of all zeros. So the conjunct is the whole mechanism, and this file's zeros are not a
 * coincidence of some other guard upstream.
 *
 * ⚠️ **Whether that is a defect is a real question and this file does not decide it.** Charging a
 * failed turn is not obviously right — the user got no answer — but the tokens WERE spent, the
 * provider WILL bill them, and a fair-share scheduler that cannot see a failing session's cost can
 * be starved by one. The two halves may not want the same answer, which is exactly why the first
 * deliverable is a measurement rather than a patch.
 *
 * 🔴 **The last two tests are controls, and without them the first two are not evidence.** An
 * assertion that a counter is zero passes just as well against a harness that never records usage
 * at all. The first control runs the SAME script minus the error and shows the counters reaching
 * the reported numbers; the second shows a *successful* turn reporting no usage still reads zero,
 * so neither direction of the rollup is silently broken. The zeros above are therefore a property
 * of the error path and not of the fixture.
 */

const REPORTED_USAGE = {
  inputTokens: 1_000,
  outputTokens: 200,
  reasoningTokens: 40,
  nonCachedInputTokens: 900,
  cacheReadInputTokens: 100,
} as const

/** The session row's usage rollup — where `applyUsage` folds every settled step. */
const usageRow = Effect.gen(function* () {
  const { db } = yield* Database.Service
  const row = yield* db
    .select({
      input: SessionTable.tokens_input,
      output: SessionTable.tokens_output,
      reasoning: SessionTable.tokens_reasoning,
      cacheRead: SessionTable.tokens_cache_read,
      cacheWrite: SessionTable.tokens_cache_write,
    })
    .from(SessionTable)
    .where(eq(SessionTable.id, HARNESS_SESSION))
    .get()
    .pipe(Effect.orDie)
  return row
})

const promptThen = (text: string) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text }), resume: false })
    yield* session.resume(HARNESS_SESSION)
    return { context: yield* session.context(HARNESS_SESSION), usage: yield* usageRow }
  })

describe("A18.3 — usage spent before a provider error", () => {
  test("a step-finish carrying REAL usage is discarded when a provider error follows it", async () => {
    // The provider streamed an answer, reported what it cost, and only then failed. Every number
    // below is one the provider itself sent; nothing here is estimated.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "Here is what I found" }),
          LLMEvent.textEnd({ id: "partial" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: REPORTED_USAGE }),
          LLMEvent.providerError({ message: "Upstream connection reset" }),
        ],
      ],
    })

    const { context, usage } = await drive(harness, promptThen("Spend tokens then fail"), "A18.3 — usage then error")

    expect(harness.requests, "a provider error must not be retried into a second turn").toHaveLength(1)
    // ⚠️ THE USAGE ASSERTION COMES FIRST DELIBERATELY. `bun:test` stops a test at its first failing
    // expectation, so with the transcript check above it the mutation control below could only ever
    // report the transcript — deleting `&& !publisher.hasProviderError()` flips `finish` to "stop"
    // too, and the claim this file exists for would never have been reached.
    //
    // The 1 000 input / 160 visible-output / 40 reasoning tokens the provider reported are gone.
    expect(usage).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
    // The turn IS recorded as a failure — this is not a case of the error being swallowed.
    expect(context).toMatchObject([
      { type: "user", text: "Spend tokens then fail" },
      { type: "assistant", finish: "error", error: { type: "unknown", message: "Upstream connection reset" } },
    ])
  }, 60_000)

  test("a severed stream with no usage frame records nothing either — including the text it did emit", async () => {
    // The literal A18.3 shape: tokens streamed, then the connection died before any usage frame. There
    // is nothing for the runner to record here even in principle, which is worth stating separately —
    // the previous case is the one where information existed and was dropped.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "partial" }),
          LLMEvent.textDelta({ id: "partial", text: "Halfway through the ans" }),
          LLMEvent.providerError({ message: "Upstream connection reset" }),
        ],
      ],
    })

    const { context, usage } = await drive(harness, promptThen("Cut me off"), "A18.3 — severed mid-stream")

    expect(harness.requests).toHaveLength(1)
    expect(context).toMatchObject([
      { type: "user", text: "Cut me off" },
      { type: "assistant", finish: "error" },
    ])
    expect(usage).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  }, 60_000)

  // CONTROL. Identical to case 1 with the `provider-error` removed. If this also read zero, the two
  // assertions above would be measuring the fixture rather than the error path.
  test("the SAME usage IS recorded when no provider error follows (control)", async () => {
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "whole" }),
          LLMEvent.textDelta({ id: "whole", text: "Here is what I found" }),
          LLMEvent.textEnd({ id: "whole" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage: REPORTED_USAGE }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ],
    })

    const { usage } = await drive(harness, promptThen("Spend tokens and succeed"), "A18.3 — control")

    // `visibleOutputTokens` is `outputTokens - reasoningTokens`, clamped — 200 - 40 = 160 — and the
    // input column takes `nonCachedInputTokens`, not the gross `inputTokens`. Spelling both out is
    // deliberate: a control that asserted "greater than zero" would still pass if the rollup started
    // double-counting the cached half.
    expect(usage).toEqual({ input: 900, output: 160, reasoning: 40, cacheRead: 100, cacheWrite: 0 })
  }, 60_000)

  // The second half of the control: a plain successful turn that reports NO usage must leave the
  // counters at zero, so "zero" above cannot be read as "the rollup is broken in both directions".
  test("a successful turn that reports no usage leaves the counters at zero (control)", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("plain", "Done.")] })

    const { usage } = await drive(harness, promptThen("No usage reported"), "A18.3 — zero control")

    expect(usage).toEqual({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 })
  }, 60_000)
})
