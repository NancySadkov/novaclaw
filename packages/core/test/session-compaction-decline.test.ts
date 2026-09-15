// A DECLINED COMPACTION MUST SAY WHICH BRANCH DECLINED.
//
// 🔴 The defect this file pins is not the silence on its own — it is what the silence let the CALLER
// say. `compactAfterOverflow` returned a bare `false` from nine separate branches, and the manual
// `/compact` cycle turned that into *"the conversation is still small enough that there is nothing
// to fold up, or the summary model was unavailable"* — a specific cause it had never learned, and
// the exact inverse of the branch that fires when a transcript is TOO LARGE to summarise in one
// pass. A user whose chat was wedged over its context ceiling was told the chat was too small.
//
// Ruling 2 (`notes/reports/decisions-v0.2.0.md`): a fault is never described falsely.
//
// The second half is the wedge itself. "Too large to summarise" used to be a dead end: the compactor
// declined, the runner sent the oversized request anyway, and every later turn overflowed — the one
// state a compactor exists to prevent, entered by the compactor declining. It now trims the oldest
// head and compacts.

import { describe, expect, test } from "bun:test"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import { CompactionBackoff } from "@novaclaw/core/session/runner/compaction-backoff"
import { packRequest } from "@novaclaw/core/session/runner/context-pack"
import type { PromptEstimate } from "@novaclaw/core/session/runner/prompt-estimate"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import type { Config } from "@novaclaw/core/config"
import type { EventV2 } from "@novaclaw/core/event"
import type { SessionMessage } from "@novaclaw/core/session/message"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import { LLM, LLMEvent, Message, Model, type FinishReason, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { Effect, Fiber, Stream } from "effect"

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message
const assistant = (text: string): SessionMessage.Message =>
  ({ type: "assistant", content: [{ type: "text", text }] }) as unknown as SessionMessage.Message
const compactionMessage = (summary: string, recent: string): SessionMessage.Message =>
  ({ type: "compaction", reason: "auto", summary, recent }) as unknown as SessionMessage.Message
const entries = (...messages: SessionMessage.Message[]): SessionCompaction.Entry[] =>
  messages.map((message, seq) => ({ seq, message }))

const sessionID = "ses_decline_test" as unknown as SessionSchema.ID

const routed = (limits: { readonly context?: number; readonly output?: number }) =>
  Model.make({ id: "decline-test", provider: "test", route: OpenAIChat.route.with({ limits }) })

type Answer = {
  readonly text: string
  readonly reason: FinishReason
  readonly fail?: boolean
}

const drive = (input: {
  readonly model: Model
  readonly entries: SessionCompaction.Entry[]
  readonly answers?: readonly Answer[]
  readonly summarize?: boolean
  readonly auto?: boolean
  readonly keepTokens?: number
  readonly through?: "overflow" | "ifNeeded"
  readonly promptEstimate?: PromptEstimate.Result
  readonly prefixCacheRetentionTokens?: number
  /** The runner's backoff decision: measurement always runs, only the SPEND is gated. */
  readonly summaryAllowed?: boolean
}) => {
  const requests: LLMRequest[] = []
  const published: string[] = []
  const ended: { readonly data: unknown; readonly metadata: unknown }[] = []
  const declines: SessionCompaction.DeclineReason[] = []
  let index = 0
  const compactor = SessionCompaction.make({
    events: {
      publish: (definition: { type: string }, data: unknown, options?: { metadata?: unknown }) =>
        Effect.sync(() => {
          published.push(definition.type)
          if (definition.type === "session.next.compaction.ended")
            ended.push({ data, metadata: options?.metadata })
        }),
    } as unknown as EventV2.Interface,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        const answer = input.answers?.[index++]
        if (answer === undefined || answer.fail)
          return Stream.fromIterable([LLMEvent.providerError({ message: "summarizer down" })])
        return Stream.fromIterable([
          LLMEvent.textDelta({ id: `summary-${index}`, text: answer.text }),
          LLMEvent.stepFinish({ index: 0, reason: answer.reason }),
        ])
      },
    } as never,
    config: [
      {
        type: "document",
        info: {
          compaction: {
            keep: { tokens: input.keepTokens ?? 8 },
            ...(input.summarize === false ? { summarize: false } : {}),
            ...(input.auto === false ? { auto: false } : {}),
          },
        },
      } as unknown as Config.Entry,
    ],
    prefixHash: () => Effect.succeed("0".repeat(64)),
  })
  const call = {
    sessionID,
    entries: input.entries,
    model: input.model,
    request: LLM.request({ model: input.model, messages: [], tools: [] }),
    promptEstimate: input.promptEstimate,
    prefixCacheRetentionTokens: input.prefixCacheRetentionTokens,
    ...(input.summaryAllowed === undefined ? {} : { summaryAllowed: input.summaryAllowed }),
    onDecline: (reason: SessionCompaction.DeclineReason) => {
      declines.push(reason)
    },
  }
  const compacted = Effect.runSync(
    input.through === "ifNeeded" ? compactor.compactIfNeeded(call) : compactor.compactAfterOverflow(call, "manual"),
  )
  const prompt = (requests[0]?.messages ?? [])
    .flatMap((message) => message.content.map((part) => ("text" in part ? part.text : "")))
    .join("\n")
  return { compacted, declines, published, ended, prompt, requests }
}

/**
 * ⭐ Exhaustive BY CONSTRUCTION. A reason added to the union without a sentence — or without a case
 * here — is a compile error, not a silently untested branch. The alternative is a list that goes
 * stale the first time somebody adds a tenth decline.
 */
const EVERY_REASON = [
  "context-window-unknown",
  "auto-disabled",
  "prune-only",
  "under-threshold",
  "nothing-to-fold",
  "context-too-small",
  "transcript-too-large",
  "summarizer-unavailable",
  "summary-unusable",
  "summarizer-backoff",
] as const
type Listed = (typeof EVERY_REASON)[number]
const _everyReasonIsListed: [Exclude<SessionCompaction.DeclineReason, Listed>] extends [never]
  ? true
  : ["add this reason to EVERY_REASON", Exclude<SessionCompaction.DeclineReason, Listed>] = true
void _everyReasonIsListed

describe("declineNotice — the sentence a user reads must be the branch that fired", () => {
  test("every reason has its own non-empty sentence", () => {
    const sentences = EVERY_REASON.map((reason) => SessionCompaction.declineNotice(reason))
    for (const sentence of sentences) expect(sentence.length).toBeGreaterThan(20)
    // Two reasons deliberately share the "nothing to fold" wording (they mean the same thing to a
    // user); everything else must be distinguishable, or the notice is back to guessing.
    expect(new Set(sentences).size).toBe(EVERY_REASON.length - 1)
  })

  /**
   * 🔴 THE CONTRADICTION, as an assertion. The shipped notice asserted "still small enough" for
   * every decline, including the one that means the opposite. No reason about SIZE-UP may ever
   * claim size-down again.
   */
  test("a chat too large to summarise is never described as too small", () => {
    const tooLarge = SessionCompaction.declineNotice("transcript-too-large")
    expect(tooLarge).not.toContain("small enough")
    expect(tooLarge).not.toContain("nothing to fold")
    expect(tooLarge).toContain("too large")
    expect(SessionCompaction.declineNotice("context-too-small")).not.toContain("nothing to fold")
    expect(SessionCompaction.declineNotice("summarizer-unavailable")).not.toContain("small enough")
    expect(SessionCompaction.declineNotice("prune-only")).not.toContain("small enough")
  })

  test("only the two size-down reasons say the conversation is small enough", () => {
    const claiming = EVERY_REASON.filter((reason) => SessionCompaction.declineNotice(reason).includes("small enough"))
    expect([...claiming].sort()).toEqual(["nothing-to-fold", "under-threshold"])
  })
})

describe("every decline names itself", () => {
  test("a route with no context window", () => {
    const run = drive({ model: routed({}), entries: entries(user("hello")) })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["context-window-unknown"])
  })

  test("prune-only mode", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user("hello"), assistant("hi")),
      summarize: false,
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["prune-only"])
  })

  test("nothing to fold", () => {
    const run = drive({ model: routed({ context: 200_000, output: 4_096 }), entries: [] })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["nothing-to-fold"])
  })

  test("an empty head with no model declines BEFORE starting a compaction audit row", () => {
    // 🔴 The anti-loop guard. Head empty means the whole conversation already fits the verbatim tail;
    // with no model to merge the carried summary, NO path can reduce the context. Starting the audit
    // row anyway would settle as a failed `compaction-status` on every turn — the loop a user sees as
    // "stuck compacting". So it declines before `Compaction.Started` is ever published.
    const run = drive({
      model: routed({ context: 4_000, output: 4_096 }),
      entries: entries(compactionMessage("previous summary", "previous tail"), user("hi"), assistant("ok")),
      through: "ifNeeded",
      summaryAllowed: false,
      promptEstimate: {
        heuristicTokens: 5_000,
        estimatedTokens: 5_000,
        correctionTokens: 0,
        marginTokens: 0,
        deltaTokens: 0,
        growth: 0,
        confidence: "whole",
        fallback: "none",
        anchorReportedTokens: 0,
        anchorHeuristicTokens: 0,
      },
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["nothing-to-fold"])
    expect(run.published).toEqual([])
    expect(run.ended).toEqual([])
  })

  test("a window too small to hold any summary still folds deterministically", () => {
    // 🔴 The old contract declined here, and that was the clause-4 hole: a 4K route could never
    // compact, so the trigger fired every turn and `context-too-small` was the whole conversation.
    // The deterministic fold needs no model and no output budget, so the chat now shrinks instead.
    const run = drive({
      model: routed({ context: 4, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.requests).toHaveLength(0)
    expect(run.ended[0]?.metadata).toMatchObject({
      "compaction.mode": "deterministic",
      "compaction.deterministic.reason": "context-too-small",
    })
  })

  test("the summarizer never answered, so the fold is deterministic instead of a decline", () => {
    // ⭐ The owner's rule: *"there should never be even a possibility of failure."* A model that never
    // answers is a reason to stop spending decode, not a reason to leave the chat over its ceiling.
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      answers: [{ text: "", reason: "error", fail: true }],
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.requests.length).toBeGreaterThan(0)
    expect(run.ended[0]?.metadata).toMatchObject({
      "compaction.mode": "deterministic",
      "compaction.deterministic.reason": "summarizer-unavailable",
    })
  })

  /**
   * 🔴 **A BACKOFF IS A REASON NOT TO SPEND, NOT A REASON TO STOP LOOKING OR TO STOP FOLDING.**
   *
   * The runner used to skip `compactIfNeeded` ENTIRELY for 30 minutes after a summarizer failure, so
   * the threshold was not measured, not logged, and the packed request was dispatched unmeasured.
   * Measured 2026-09-14 (`ses_daedalus`): eight failed compactions, and the turn that produced the
   * HTTP 400 went out at an estimated 281,140 tokens against a 235,929 ceiling 148 ms after
   * compaction gave up. The chat is at its most dangerous DURING a backoff.
   *
   * ⭐ Under the owner's never-fail rule the backoff now skips only the SPEND: the cycle measures,
   * folds deterministically, and spends no provider call. An over-threshold chat never just sits there.
   */
  test("a summarizer backoff spends no provider call and folds deterministically", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      through: "ifNeeded",
      summaryAllowed: false,
      // Over the threshold, so the threshold branch above it (`under-threshold`) did not fire.
      promptEstimate: {
        heuristicTokens: 300_000,
        estimatedTokens: 300_000,
        correctionTokens: 0,
        marginTokens: 0,
        deltaTokens: 0,
        growth: 0,
        confidence: "whole",
        fallback: "none",
        anchorReportedTokens: 0,
        anchorHeuristicTokens: 0,
      },
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.requests).toHaveLength(0)
    expect(run.ended[0]?.metadata).toMatchObject({
      "compaction.mode": "deterministic",
      "compaction.deterministic.reason": "summarizer-backoff",
    })
  })

  /** The same call WITH the spend allowed reaches the summarizer — the gate is the only difference. */
  test("the same over-threshold call compacts when the backoff has elapsed", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      through: "ifNeeded",
      summaryAllowed: true,
      answers: [{ text: "## Goal\n- fold it", reason: "stop" }],
      promptEstimate: {
        heuristicTokens: 300_000,
        estimatedTokens: 300_000,
        correctionTokens: 0,
        marginTokens: 0,
        deltaTokens: 0,
        growth: 0,
        confidence: "whole",
        fallback: "none",
        anchorReportedTokens: 0,
        anchorHeuristicTokens: 0,
      },
    })
    expect(run.compacted).toBe(true)
    expect(run.requests.length).toBeGreaterThan(0)
  })

  test("an answer no bounded retry can rescue folds deterministically", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      answers: [{ text: "## Goal\n- keep going", reason: "content-filter" }],
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.ended[0]?.metadata).toMatchObject({
      "compaction.mode": "deterministic",
      "compaction.deterministic.reason": "summary-unusable",
    })
  })

  test("the automatic trigger's own exits report through the same channel", () => {
    const off = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user("hello")),
      auto: false,
      through: "ifNeeded",
    })
    expect(off.declines).toEqual(["auto-disabled"])
    const under = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user("hello"), assistant("hi")),
      through: "ifNeeded",
    })
    expect(under.declines).toEqual(["under-threshold"])
  })

  test("a cache-retention target never lowers the model's semantic compaction ceiling", () => {
    const estimate: PromptEstimate.Result = {
      heuristicTokens: 120_000,
      estimatedTokens: 120_000,
      correctionTokens: 0,
      marginTokens: 0,
      deltaTokens: 0,
      growth: 1,
      confidence: "whole",
      fallback: "none",
      anchorReportedTokens: 0,
      anchorHeuristicTokens: 0,
    }
    const run = drive({
      model: routed({ context: 262_144, output: 16_384 }),
      entries: entries(user("hello"), assistant("hi")),
      through: "ifNeeded",
      promptEstimate: estimate,
      prefixCacheRetentionTokens: 100_000,
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["under-threshold"])
    expect(run.requests).toHaveLength(0)
  })

  /**
   * The control that makes the rest of this describe mean something: a cycle that SUCCEEDS reports
   * no reason at all. Without it, an `onDecline` fired unconditionally would pass every test above.
   */
  test("a successful compaction declines nothing", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      answers: [{ text: "## Goal\n- keep going", reason: "stop" }],
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.published).toEqual([
      "session.next.compaction.started",
      "session.next.compaction.delta",
      "session.next.compaction.ended",
    ])
  })
})

describe("a transcript too large for one summarization pass is trimmed, not refused", () => {
  /**
   * 🔴 The wedge. `overflowRecentBudget` shrinks the verbatim TAIL on the recovery path, so the head
   * is whatever remains — and a head bigger than one pass used to return `false` with the session
   * already over its ceiling. Measured here as the thing that actually matters: the summarizer is
   * REACHED, and the prompt it is handed fits the window.
   */
  test("it compacts, and the prompt it sends fits the window", () => {
    const context = 12_000
    const model = routed({ context, output: 4_096 })
    const run = drive({
      model,
      // ~30k tokens of head against a 12k window: no single pass can carry it whole.
      entries: entries(
        user(`ancient ${"alpha ".repeat(9_000)}`),
        assistant(`older ${"beta ".repeat(9_000)}`),
        user("the newest question"),
        assistant("the newest answer"),
      ),
      answers: [{ text: "## Goal\n- carry on", reason: "stop" }],
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.requests.length).toBe(1)
    expect(SessionCompaction.estimate(run.prompt)).toBeLessThan(context)
    // The omission is STATED in the prompt the model reads, not silently applied.
    expect(run.prompt).toContain("Older conversation omitted here")
    // …and what survived is the NEWEST end of the head, never the oldest.
    expect(run.prompt).toContain("beta")
    expect(run.prompt.indexOf("Older conversation omitted here")).toBeLessThan(run.prompt.indexOf("beta"))
  })

  /**
   * The other side: a carried summary alone overruns the window, so no semantic pass can fit — and
   * the deterministic fold carries the previous summary verbatim instead. The decline that used to
   * live here is exactly the "possibility of failure" the owner ruled out.
   */
  test("even a carried summary too large to trim folds deterministically", () => {
    const carried = `carried ${"gamma ".repeat(20_000)}`
    const run = drive({
      model: routed({ context: 8_000, output: 4_096 }),
      entries: entries(
        compactionMessage(carried, "carried tail"),
        user("a new question"),
        assistant("a new answer"),
      ),
    })
    expect(run.compacted).toBe(true)
    expect(run.declines).toEqual([])
    expect(run.requests).toHaveLength(0)
    expect(run.ended[0]?.metadata).toMatchObject({
      "compaction.mode": "deterministic",
      "compaction.deterministic.reason": "transcript-too-large",
    })
    // The previous summary is CARRIED, not thrown away: the fold is deterministic, not amnesiac.
    expect((run.ended[0]?.data as { readonly text?: string } | undefined)?.text).toBe(carried)
  })
})

describe("the Geryon sleep-recovery regression", () => {
  test("a hung compactor yields to a new chat and folds deterministically instead of failing", async () => {
    const scheduler = SessionScheduler.make()
    const model = routed({ context: 12_000, output: 4_096 })
    const declines: SessionCompaction.DeclineReason[] = []
    let summaryCalls = 0
    const compactor = SessionCompaction.make({
      scheduler,
      events: { publish: () => Effect.void } as unknown as EventV2.Interface,
      llm: {
        stream: () => {
          summaryCalls++
          return Stream.never
        },
      },
      config: [
        {
          type: "document",
          info: { compaction: { keep: { tokens: 8 } } },
        } as unknown as Config.Entry,
      ],
      prefixHash: () => Effect.succeed("0".repeat(64)),
    })
    const compactionInput = {
      sessionID,
      entries: entries(
        user(`ancient ${"alpha ".repeat(3_000)}`),
        assistant(`work ${"beta ".repeat(1_000)}`),
        user("the current question"),
        assistant("the current answer"),
      ),
      model,
      request: LLM.request({ model, messages: [], tools: [] }),
      maintenance: { ownerID: "geryon", task: "compaction", deviceKey: "spark" },
      onDecline: (reason: SessionCompaction.DeclineReason) => declines.push(reason),
    }

    const hung = Effect.runFork(compactor.compactAfterOverflow(compactionInput))
    const maintenanceDeadline = Date.now() + 1_000
    while ((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightMaintenance.length !== 1) {
      if (Date.now() >= maintenanceDeadline) throw new Error("compaction never acquired its maintenance lease")
      await Bun.sleep(5)
    }
    expect(summaryCalls).toBe(1)

    // The exact incident: while Geryon's summary stream never answers, Daedalus arrives on the
    // same device. Foreground admission must abort the maintenance decode rather than merely put a
    // second request beside it on an already-starved model server.
    const admittedAt = Date.now()
    await Effect.runPromise(scheduler.admit({ sessionID: "daedalus", deviceKey: "spark", sessionClass: "interactive-focused" }))
    const compacted = await Promise.race([
      Effect.runPromise(Fiber.join(hung)),
      Bun.sleep(1_000).then(() => {
        throw new Error("foreground admission did not preempt the hung compactor")
      }),
    ])
    expect(compacted).toBe(true)
    expect(Date.now() - admittedAt).toBeLessThan(1_000)
    // ⭐ The preempted summary is no longer a failed compaction: the deterministic fold runs on the
    // same turn, so Geryon's chat shrinks even though its summarizer never answered. The old contract
    // declined here and left the chat over its ceiling for the next turn to trip over.
    expect(declines).toEqual([])
    expect((await Effect.runPromise(scheduler.snapshot()))[0]).toMatchObject({
      inFlightInteractive: ["daedalus"],
      inFlightMaintenance: [],
    })

    // A successful fold CLEARS the retry watermark (it did not fail), so the following turn launches
    // no further summary decode — and the deterministic packer still fits the outgoing request.
    const retryAt = CompactionBackoff.afterAttempt({
      now: 10_000,
      compacted,
      decline: declines[0],
    })
    expect(retryAt).toBeUndefined()
    expect(CompactionBackoff.due(retryAt, 10_001)).toBe(true)
    expect(summaryCalls).toBe(1)

    const packed = packRequest({
      request: LLM.request({
        model,
        messages: [
          Message.user(`old request ${"gamma ".repeat(6_000)}`),
          Message.assistant(`old answer ${"delta ".repeat(6_000)}`),
          Message.user("continue safely"),
        ],
        tools: [],
      }),
      contextSize: 12_000,
    })
    expect(packed.dropped).toBeGreaterThan(0)
    expect(packed.messages.at(-1)).toEqual(Message.user("continue safely"))

    await Effect.runPromise(scheduler.release({ sessionID: "daedalus", deviceKey: "spark" }))
  }, 3_000)
})

/**
 * ⭐ **CLAUSE 4: THE WINDOW TABLE, AND THE NEVER-FAIL PROPERTY IT PINS.**
 *
 * `invariants.md` (Context Management 4): *"We support context sizes from 4K and up, so our unit and
 * smoke tests should cover range from 4K to 256K (inclusive) in power of two intervals."* The small
 * end is where the harness actually broke: `promptCeilingTokens` is `window − reserve`, and the
 * reserve's floors (8,192 and the 20,000 buffer) swallow a 4K window whole, so the ceiling was ZERO
 * and `estimate > 0` fired the trigger on every turn — a compaction loop that folded nothing.
 *
 * Two properties per window, both at the floor:
 *   1. the trigger's ceiling is POSITIVE (a zero ceiling is the loop);
 *   2. whether or not the summarizer answers, the cycle COMMITS a fold — semantic when a model can
 *      answer, deterministic when it cannot. There is no third outcome.
 */
describe("the 4K..256K window table", () => {
  const WINDOWS = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144] as const
  const overThreshold = (window: number): PromptEstimate.Result => ({
    heuristicTokens: window,
    estimatedTokens: window,
    correctionTokens: 0,
    marginTokens: 0,
    deltaTokens: 0,
    growth: 0,
    confidence: "whole",
    fallback: "none",
    anchorReportedTokens: 0,
    anchorHeuristicTokens: 0,
  })
  const conversation = () =>
    entries(
      user(`old ${"detail ".repeat(400)}`),
      assistant(`done ${"more ".repeat(200)}`),
      user("the current question"),
      assistant("the current answer"),
    )

  for (const window of WINDOWS) {
    test(`a ${window}-token window compacts with a model`, () => {
      const run = drive({
        model: routed({ context: window, output: 4_096 }),
        entries: conversation(),
        through: "ifNeeded",
        summaryAllowed: true,
        answers: [{ text: "## Goal\n- keep going", reason: "stop" }],
        promptEstimate: overThreshold(window),
      })
      expect(run.compacted).toBe(true)
      expect(run.declines).toEqual([])
      // A 4K window cannot hold a 4,096-token summary, so it folds deterministically; every larger
      // window summarises. Either way the cycle commits a fold.
      expect(run.ended.at(-1)?.metadata).toMatchObject({
        "compaction.mode": expect.stringMatching(/^(semantic|deterministic)$/),
      })
      expect((run.ended.at(-1)?.metadata as { readonly "compaction.threshold"?: number })["compaction.threshold"]).toBeGreaterThan(0)
    })

    test(`a ${window}-token window still folds when no model can answer`, () => {
      const run = drive({
        model: routed({ context: window, output: 4_096 }),
        entries: conversation(),
        through: "ifNeeded",
        summaryAllowed: false,
        promptEstimate: overThreshold(window),
      })
      // The summarizer is not merely unavailable — it is not consulted (`summaryAllowed: false`), and
      // no request is spent. The deterministic fold is what keeps the chat from staying over ceiling.
      expect(run.compacted).toBe(true)
      expect(run.declines).toEqual([])
      expect(run.requests).toHaveLength(0)
      expect(run.ended.at(-1)?.metadata).toMatchObject({ "compaction.mode": "deterministic" })
    })
  }
})
