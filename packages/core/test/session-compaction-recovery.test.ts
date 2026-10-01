import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Duration, Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, Model, SystemPart, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import { ProviderDispatch } from "@novaclaw/core/session/runner/provider-dispatch"
import { PromptEstimate } from "@novaclaw/core/session/runner/prompt-estimate"
import { CompactionBackoff } from "@novaclaw/core/session/runner/compaction-backoff"
import { toLLMMessages } from "@novaclaw/core/session/runner/to-llm-message"
import { Token } from "@novaclaw/core/util/token"

const user = (text: string) => ({ type: "user", text })
const checkpoint = (summary: string, recent: string, window = 1_048_576) => ({
  type: "compaction",
  summary,
  recent,
  metadata: { "compaction.window": window },
})
async function compact(input: {
  context?: number
  messages: unknown[]
  answer?: string
  request?: LLMRequest
  scratchFolder?: string
  summaryAllowed?: boolean
  summarize?: boolean
  unbounded?: boolean
  chunkSize?: number
  reasoning?: boolean
  hang?: boolean
  settleWithin?: number
}) {
  const context = input.context ?? 32_768
  const model = Model.make({
    id: "recovery",
    provider: "test",
    route: OpenAIChat.route.with({ limits: { context, output: 32_768 } }),
  })
  const requests: LLMRequest[] = []
  let deltas = 0
  let started: any
  let ended: any
  let outcome: SessionCompaction.Outcome | undefined
  const compactor = SessionCompaction.make({
    events: {
      publish: (definition: any, data: any, options: any) =>
        Effect.sync(() => {
          if (definition.type === "session.next.compaction.started") started = { ...data, metadata: options?.metadata }
          if (definition.type === "session.next.compaction.ended") ended = { ...data, metadata: options?.metadata }
        }),
    } as never,
    llm: {
      stream: (request) => {
        requests.push(request)
        if (input.hang) return Stream.never
        if (input.unbounded)
          return Stream.fromIterable<LLMEvent>(
            (function* () {
              while (true) {
                deltas++
                const delta = { id: "unbounded", text: "ignored output limit ".repeat(100) }
                yield input.reasoning ? LLMEvent.reasoningDelta(delta) : LLMEvent.textDelta(delta)
              }
            })(),
            { chunkSize: input.chunkSize ?? 1 },
          )
        return Stream.fromIterable<LLMEvent>(
          input.answer === undefined
            ? [LLMEvent.providerError({ message: "provider offline" })]
            : [
                LLMEvent.textDelta({ id: "summary", text: input.answer }),
                LLMEvent.stepFinish({ index: 0, reason: "stop" }),
              ],
        )
      },
    },
    override: { summarize: input.summarize } as never,
    prefixHash: () => Effect.succeed("a".repeat(64)),
  })
  const request =
    input.request ??
    LLM.request({ model, system: [SystemPart.make("System rules. ".repeat(300))], messages: [], tools: [] })
  const cycle = compactor.compactAfterOverflow({
    sessionID: "ses_recovery" as never,
    model,
    request,
    entries: input.messages.map((message, i) => ({ seq: i + 1, message })) as never,
    scratchFolder: input.scratchFolder,
    summaryAllowed: input.summaryAllowed,
    onOutcome: (value) => {
      outcome = value
    },
  })
  // `settleWithin` is the interrupt the test DELIVERS, not a guard the code has: a timeout here
  // tears the fiber down exactly the way a Stop, a lease steal or a preempted drain does.
  const bounded =
    input.settleWithin === undefined ? cycle : cycle.pipe(Effect.timeout(Duration.millis(input.settleWithin)))
  const compacted = await Effect.runPromise(bounded).catch((error: unknown) => {
    if (input.settleWithin === undefined) throw error
    return error
  })
  const overlay =
    ended === undefined ? undefined : { ...ended, type: "compaction", id: ended.messageID, summary: ended.text }
  return { compacted, started, ended, overlay, outcome, requests, model, request, deltas }
}

for (let context = 4096; context <= 1_048_576; context *= 2) {
  for (const semantic of [false, true])
    test(`${context}: ${semantic ? "semantic" : "offline"} recovery leaves room for the next turn`, async () => {
      const run = await compact({
        context,
        messages: [user("older evidence ".repeat(Math.ceil(context / 3))), user("NEWEST_USER_REQUEST")],
        answer: semantic ? "Continue the newest user request using the saved evidence." : undefined,
      })
      expect(run.compacted).toBe(true)
      expect(run.ended.failure).toBeUndefined()
      expect(run.outcome?.mode).toBe(semantic ? "semantic" : "deterministic")
      expect(run.ended.recent).toContain("NEWEST_USER_REQUEST")
      expect(run.ended.metadata["compaction.after.tokens"]).toBeLessThanOrEqual(
        run.ended.metadata["compaction.replacement.budget"],
      )
      for (const request of run.requests)
        expect(PromptEstimate.whole(request) + request.generation!.maxTokens!).toBeLessThanOrEqual(context)
      const rebuilt = LLM.request({
        model: run.model,
        system: run.request.system,
        messages: [...toLLMMessages([run.overlay], run.model), Message.user("Continue.")],
        tools: [],
      })
      const packed = ProviderDispatch.prepare({ request: rebuilt, contextSize: context, promptCacheKey: "test" })
      expect(packed.packed.fits).toBe(true)
      expect(packed.packed.dropped).toBe(0)
      expect(packed.request.system).toEqual(rebuilt.system)
      expect(PromptEstimate.withMargin(PromptEstimate.unsupported(packed.request))).toBeLessThan(
        context - packed.request.generation!.maxTokens!,
      )
    }, 30_000)
}

test("a checkpoint alone can shrink from 1M to 4K without calling a provider", async () => {
  const run = await compact({
    context: 4096,
    messages: [checkpoint("older summary ".repeat(16_000), "old recent ".repeat(8000) + "LATEST_FACT")],
  })
  expect(run.compacted).toBe(true)
  expect(run.requests).toHaveLength(0)
  expect(run.ended.recent).toContain("LATEST_FACT")
  expect(Token.estimate(run.ended.recent)).toBeLessThan(1000)
})

test("inflation falls back to the original evidence and preserves semantic failure backoff", async () => {
  const run = await compact({
    messages: [user("Original user goal. ".repeat(30))],
    answer: "invented expansion ".repeat(100),
  })
  expect(run.compacted).toBe(true)
  expect(run.outcome).toEqual({ mode: "deterministic", reason: "summary-unusable" })
  expect(run.ended.recent).not.toContain("invented expansion")
  const retryAt = CompactionBackoff.afterAttempt({
    now: 100,
    compacted: true,
    mode: run.outcome?.mode,
    decline: run.outcome?.reason,
  })
  expect(retryAt).toBe(100 + CompactionBackoff.FAILURE_MS)
  expect(
    CompactionBackoff.afterAttempt({
      now: 101,
      current: retryAt,
      compacted: true,
      mode: "deterministic",
      decline: "summarizer-backoff",
    }),
  ).toBe(retryAt)
})

test("summarization sees the covered history even when dispatch already evicted it", async () => {
  const model = Model.make({
    id: "test",
    provider: "test",
    route: OpenAIChat.route.with({ limits: { context: 32768, output: 4096 } }),
  })
  const run = await compact({
    messages: [user("CRITICAL_OLD_INSTRUCTION " + "history ".repeat(2000)), user("latest question")],
    request: LLM.request({ model, messages: [Message.user("latest question")], tools: [] }),
    answer: "Preserve the critical instruction.",
  })
  expect(JSON.stringify(run.requests[0]?.messages)).toContain("CRITICAL_OLD_INSTRUCTION")
  expect(run.ended.prefixSeq).toBe(2)
})

test("a deterministic archive contains prior recent context and complete tool output", async () => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "compaction-recovery-"))
  try {
    const run = await compact({
      context: 4096,
      scratchFolder: scratch,
      summaryAllowed: false,
      messages: [
        checkpoint("PREVIOUS_SUMMARY", "PREVIOUS_RECENT"),
        { type: "shell", command: "test", output: "full output ".repeat(4000) + "TOOL_OUTPUT_END" },
        user("latest request"),
      ],
    })
    expect(run.compacted).toBe(true)
    const archive = await fs.readFile(run.ended.metadata["compaction.folded.file"], "utf8")
    for (const marker of ["PREVIOUS_SUMMARY", "PREVIOUS_RECENT", "TOOL_OUTPUT_END"]) expect(archive).toContain(marker)
  } finally {
    await fs.rm(scratch, { recursive: true, force: true })
  }
})

test("disabling the model summary still commits bounded deterministic recovery", async () => {
  const run = await compact({ context: 4096, messages: [user("history ".repeat(4000))], summarize: false })
  expect(run.compacted).toBe(true)
  expect(run.requests).toHaveLength(0)
  expect(run.outcome).toEqual({ mode: "deterministic", reason: "prune-only" })
})

test("a provider that ignores output limits is cancelled and recovered deterministically", async () => {
  const run = await compact({ context: 4096, messages: [user("history ".repeat(4000))], unbounded: true })
  expect(run.compacted).toBe(true)
  expect(run.requests).toHaveLength(1)
  expect(run.deltas).toBeLessThan(34)
  expect(run.outcome).toEqual({ mode: "deterministic", reason: "summary-unusable" })
})

test("batched output cannot bypass the streaming summary bound", async () => {
  const run = await compact({
    context: 4096,
    messages: [user("history ".repeat(4000))],
    unbounded: true,
    chunkSize: 128,
  })
  expect(run.compacted).toBe(true)
  expect(run.deltas).toBe(128)
  expect(run.ended.generatedChars).toBeLessThanOrEqual(Math.max(4096, run.requests[0]!.generation!.maxTokens! * 16))
  expect(run.outcome).toEqual({ mode: "deterministic", reason: "summary-unusable" })
})

test("a provider that ignores disabled reasoning is also cancelled", async () => {
  const run = await compact({
    context: 4096,
    messages: [user("history ".repeat(4000))],
    unbounded: true,
    reasoning: true,
  })
  expect(run.compacted).toBe(true)
  expect(run.deltas).toBeLessThan(34)
  expect(run.outcome).toEqual({ mode: "deterministic", reason: "summary-unusable" })
})

test("bounded semantic evidence preserves the previous summary across a large new tail", async () => {
  const run = await compact({
    context: 65536,
    messages: [
      checkpoint("ANCHORED_CRITICAL_FACT", "prior recent", 65536),
      user("new evidence ".repeat(32000) + "LATEST_FACT"),
    ],
    answer: "Preserve the anchored fact and continue.",
  })
  expect(run.outcome?.mode).toBe("semantic")
  const evidence = JSON.stringify(run.requests[0]?.messages)
  expect(evidence).toContain("ANCHORED_CRITICAL_FACT")
  expect(evidence).toContain("LATEST_FACT")
  expect(PromptEstimate.whole(run.requests[0]!)).toBeLessThanOrEqual(SessionCompaction.DEFAULT_SUMMARY_INPUT_TOKENS)
})

/**
 * The ratchet for the defect measured on a live packaged instance (`ses_lamprias`,
 * 2026-10-01 18:51:18Z–18:52:53Z): six `compaction.started` events with no `compaction.ended`
 * among them, and therefore six `compaction-status` rows frozen at `status: "running"` — which the
 * transcript renders, permanently, as "Compacting the context ~0 tokens".
 *
 * A started row is a CLAIM that work is in progress, so the only acceptable number of terminal
 * events for one start is exactly one, on EVERY exit. An interrupt is the exit that was missing, and
 * it is not exotic: a Stop, a lease steal, a preempted drain and a process death all arrive that way.
 */
test("an interrupted compaction settles its audit row instead of leaving it running", async () => {
  const run = await compact({
    context: 4096,
    messages: [user("history ".repeat(4000))],
    hang: true,
    settleWithin: 40,
  })
  expect(run.started?.messageID).toBeDefined()
  expect(run.ended?.messageID).toBe(run.started.messageID)
  expect(run.ended.failure).toBe("interrupted")
  // A failure settlement must not be mistaken for a fold: the projector skips the compaction
  // overlay for a `failure`, so an empty text/recent here is what leaves history untouched.
  expect(run.ended.text).toBe("")
  expect(run.ended.recent).toBe("")
  expect(run.ended.prefixSeq).toBe(1)
  expect(run.ended.prefixHash).toBe("a".repeat(64))
  expect(run.compacted).not.toBe(true)
})

test("a compaction that settles normally still publishes exactly one terminal event", async () => {
  const run = await compact({ context: 4096, messages: [user("history ".repeat(4000))] })
  expect(run.started?.messageID).toBeDefined()
  expect(run.ended.messageID).toBe(run.started.messageID)
  expect(run.ended.failure).toBeUndefined()
  expect(run.compacted).toBe(true)
})

test("a decline before the start stays silent — the finalizer settles nothing it did not start", async () => {
  // A transcript with nothing foldable declines BEFORE the row exists, so neither event may fire.
  // This is the other half of the invariant: the settlement belongs to a started row and to nothing
  // else, which is what keeps the counter honest in both directions.
  const run = await compact({ context: 4096, messages: [user("x")], summaryAllowed: false })
  expect(run.started).toBeUndefined()
  expect(run.ended).toBeUndefined()
  expect(run.compacted).toBe(false)
})
