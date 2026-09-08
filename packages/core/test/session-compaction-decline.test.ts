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
}) => {
  const requests: LLMRequest[] = []
  const published: string[] = []
  const declines: SessionCompaction.DeclineReason[] = []
  let index = 0
  const compactor = SessionCompaction.make({
    events: {
      publish: (definition: { type: string }) =>
        Effect.sync(() => {
          published.push(definition.type)
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
  return { compacted, declines, published, prompt, requests }
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

  test("a window too small to hold any summary at all", () => {
    const run = drive({
      model: routed({ context: 4, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["context-too-small"])
  })

  test("the summarizer never answered", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      answers: [{ text: "", reason: "error", fail: true }],
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["summarizer-unavailable"])
  })

  test("the summarizer answered in a shape no bounded retry can rescue", () => {
    const run = drive({
      model: routed({ context: 200_000, output: 4_096 }),
      entries: entries(user(`old ${"detail ".repeat(200)}`), assistant("done"), user("new"), assistant("ok")),
      answers: [{ text: "## Goal\n- keep going", reason: "content-filter" }],
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["summary-unusable"])
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
   * The other side: when even an empty head does not fit — a carried summary alone overruns the
   * window — there is nothing left to trim and the user must be told THAT, not that the chat is
   * small.
   */
  test("when no amount of trimming can fit, it declines with the honest reason", () => {
    const run = drive({
      model: routed({ context: 8_000, output: 4_096 }),
      entries: entries(
        compactionMessage(`carried ${"gamma ".repeat(20_000)}`, "carried tail"),
        user("a new question"),
        assistant("a new answer"),
      ),
    })
    expect(run.compacted).toBe(false)
    expect(run.declines).toEqual(["transcript-too-large"])
    expect(run.requests.length).toBe(0)
    expect(SessionCompaction.declineNotice(run.declines[0]!)).toContain("too large")
  })
})

describe("the Geryon sleep-recovery regression", () => {
  test("a hung compactor yields to a new chat, falls back deterministically, and stays backed off next turn", async () => {
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
    await Effect.runPromise(scheduler.admit({ sessionID: "daedalus", deviceKey: "spark", sessionClass: "interactive" }))
    const compacted = await Promise.race([
      Effect.runPromise(Fiber.join(hung)),
      Bun.sleep(1_000).then(() => {
        throw new Error("foreground admission did not preempt the hung compactor")
      }),
    ])
    expect(compacted).toBe(false)
    expect(Date.now() - admittedAt).toBeLessThan(1_000)
    expect(declines).toEqual(["summarizer-unavailable"])
    expect((await Effect.runPromise(scheduler.snapshot()))[0]).toMatchObject({
      inFlightInteractive: ["daedalus"],
      inFlightMaintenance: [],
    })

    // Persist the same named outcome the runner receives. The following tool turn must not launch
    // another summary decode, but it must still fit the outgoing request deterministically.
    const failedAt = 10_000
    const retryAt = CompactionBackoff.afterAttempt({
      now: failedAt,
      compacted,
      decline: declines[0],
    })
    expect(CompactionBackoff.due(retryAt, failedAt + 1)).toBe(false)
    if (CompactionBackoff.due(retryAt, failedAt + 1))
      await Effect.runPromise(compactor.compactAfterOverflow(compactionInput))
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
