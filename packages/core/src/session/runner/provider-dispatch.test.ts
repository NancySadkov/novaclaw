import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Stream } from "effect"
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import fs from "node:fs"
import path from "node:path"
import {
  LLM,
  LLMError,
  LLMEvent,
  Message,
  Model,
  RateLimitReason,
  SystemPart,
  TransportReason,
  Usage,
  type LLMRequest,
} from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { RequestExecutor } from "@novaclaw/llm/route"
import { SessionSchema } from "../schema"
import { SessionScheduler } from "../scheduler"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { Token } from "../../util/token"
import { ProviderCapability } from "../../provider-capability"
import { ContextPack } from "./context-pack"
import { PromptEstimate } from "./prompt-estimate"
import { ProviderDispatch } from "./provider-dispatch"

const events = {
  publish: () => Effect.void,
} as never

const transient = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message: "provider restarting" }),
  })

const immediateTransient = () =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new RateLimitReason({ message: "provider busy", retryAfterMs: 0 }),
  })

describe("ProviderDispatch", () => {
  test("the compaction buffer preserves a small conversation across every supported context size", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const request = LLM.request({
      model,
      generation: { maxTokens: 512 },
      messages: [
        Message.user("Remember the launch code is cobalt."),
        Message.assistant("I will remember cobalt."),
        Message.user("What launch code did I give you?"),
      ],
    })
    for (let contextSize = 4096; contextSize <= 262144; contextSize *= 2) {
      const prepared = ProviderDispatch.prepare({
        request,
        promptCacheKey: "small",
        contextSize,
        minimumResponseReserveTokens: 20_000,
      })
      expect(prepared.request.messages, `${contextSize}-token context`).toEqual(request.messages)
      expect(prepared.packed.fits).toBe(true)
      expect(PromptEstimate.whole(prepared.request) + 512).toBeLessThan(contextSize)
    }
  })

  test("last-resort hard packing reaches the production dispatcher", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const input = {
      request: LLM.request({
        model,
        generation: { maxTokens: 512 },
        messages: [Message.user("T".repeat(80_000)), Message.assistant("a".repeat(2_000))],
      }),
      promptCacheKey: "hard",
      contextSize: 16_384,
      promptMarginTokens: 0,
    }
    expect(ProviderDispatch.prepare(input).packed.fits).toBe(false)
    const hard = ProviderDispatch.prepare({ ...input, hard: true })
    expect(hard.packed.fits).toBe(true)
    expect(hard.request.messages).toEqual([Message.assistant("a".repeat(2_000))])
  })

  for (const boundary of ["budget", "answer"] as const) {
    test(`separate reasoning cancels its source and releases its lease at the ${boundary} boundary`, async () => {
      const model = Model.make({ id: "answer", provider: "fake", route: OpenAIChat.route })
      const reasoner = Model.make({ id: "reasoner", provider: "fake", route: OpenAIChat.route })
      const phases: string[] = []
      let chunks = 0
      const llm = {
        stream: (request: LLMRequest) =>
          request.model.id === reasoner.id
            ? Stream.fromEffectRepeat(
                Effect.sync(() => {
                  chunks++
                  return boundary === "answer"
                    ? LLMEvent.textDelta({ id: "r", text: "conclusion" })
                    : LLMEvent.reasoningDelta({ id: "r", text: "abcdefghij" })
                }),
              ).pipe(
                Stream.ensuring(
                  Effect.sync(() => {
                    phases.push("cancelled")
                  }),
                ),
              )
            : Stream.unwrap(
                Effect.sync(() => {
                  phases.push("answer")
                  return Stream.make(LLMEvent.textDelta({ id: "a", text: "Done" }))
                }),
              ),
      } as never
      const output = await Effect.runPromise(
        ProviderDispatch.stream({
          llm,
          request: LLM.request({ model, messages: [Message.user("solve")] }),
          enabled: true,
          budget: 4,
          reasoningModel: reasoner,
          reasoningPhase: {
            enter: Effect.void,
            leave: () =>
              Effect.sync(() => {
                phases.push("released")
              }),
          },
        }).pipe(Stream.runCollect, Effect.timeout(2_000)),
      )
      expect(chunks).toBe(boundary === "budget" ? 2 : 1)
      expect(phases).toEqual(["cancelled", "released", "answer"])
      expect(Array.from(output)).toEqual([LLMEvent.textDelta({ id: "a", text: "Done" })])
    })
  }

  test("zero-budget officers disable reasoning without dropping existing provider options", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const request = ProviderDispatch.withoutReasoning(
      LLM.request({
        model,
        messages: [Message.user("classify this")],
        providerOptions: {
          openai: { promptCacheKey: "stable" },
          gemini: { thinkingConfig: { includeThoughts: true } },
          anthropic: { thinking: { type: "enabled", budgetTokens: 1024 }, beta: "keep" },
        },
        http: { body: { temperature: 0, chat_template_kwargs: { custom: true } } },
      }),
    )

    expect(request.providerOptions?.openai).toMatchObject({ promptCacheKey: "stable", reasoningEffort: "none" })
    expect(request.providerOptions?.anthropic).toEqual({ thinking: { type: "disabled" }, beta: "keep" })
    expect(request.providerOptions?.gemini?.thinkingConfig).toEqual({ thinkingBudget: 0, includeThoughts: false })
    expect(request.http?.body).toMatchObject({
      temperature: 0,
      chat_template_kwargs: { custom: true, enable_thinking: false },
    })
  })

  test("a learned effort floor replaces the neutral 'none' a no-thinking request would send", () => {
    // 🔴 The model refused "none" and named `minimal`; the resolver threads that onto compatibility
    // (`model.ts`), and a zero-budget turn must then ask for the floor rather than repeat the refusal.
    const model = Model.make({
      id: "muse",
      provider: "gateway",
      route: OpenAIChat.route,
      compatibility: { reasoningEffortFloor: "minimal" },
    })
    const request = ProviderDispatch.withoutReasoning(LLM.request({ model, messages: [Message.user("summarise")] }))
    expect(request.providerOptions?.openai).toMatchObject({ reasoningEffort: "minimal" })
  })

  test("normal and Strict turns consume all three shared dispatch stages", () => {
    for (const name of ["llm.ts", "strict-drain.ts"]) {
      const source = fs.readFileSync(path.join(import.meta.dir, name), "utf8")
      for (const stage of ["prepare", "stream"])
        expect(source, `${name} bypasses ProviderDispatch.${stage}`).toContain(`ProviderDispatch.${stage}(`)
      expect(source, `${name} bypasses the provider ownership bracket`).toMatch(
        /ProviderDispatch\.(?:run|runAndSettle)\(/,
      )
    }
  })

  test("normal and every long-lived Strict dispatch consult the persisted model switch", () => {
    const ordinary = fs.readFileSync(path.join(import.meta.dir, "llm.ts"), "utf8")
    const strict = fs.readFileSync(path.join(import.meta.dir, "strict-drain.ts"), "utf8")
    const short = fs.readFileSync(path.join(import.meta.dir, "short-answer.ts"), "utf8")
    const compaction = fs.readFileSync(path.join(import.meta.dir, "..", "compaction.ts"), "utf8")
    const maintenance = fs.readFileSync(path.join(import.meta.dir, "maintenance.ts"), "utf8")

    expect(ordinary).toContain("guardDispatch(attemptModelRef, runProviderStream)")
    expect(ordinary).toContain("retryOnReplacedModel(currentStep)")
    expect(strict.match(/attempt: guardAttempt\(attempt\)/g)?.length).toBe(2)
    expect(short).toContain("readonly guard: SessionRunnerModel.DispatchGuard")
    expect(short.match(/guardedStream/g)?.length).toBe(3)
    expect(compaction).toContain("Stream.unwrap(input.guard(Effect.sync(() => dependencies.llm.stream(request))))")
    expect(maintenance.match(/guard\(\s*Effect\.suspend/g)?.length).toBe(2)

    // Each production compaction door carries the bound catalog identity. Isolated compactor unit
    // seams may omit it; the live runner may not.
    const calls = ordinary.split(/attemptCompaction\(\s*prepared,\s*[^,]+,\s*\{/).slice(1)
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call.slice(0, 500)).toContain("guard:")
  })

  test("prepares one cache-keyed, context-packed request", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const prepared = ProviderDispatch.prepare({
      request: LLM.request({
        model,
        messages: [Message.user("old".repeat(20_000)), Message.user("new task")],
      }),
      promptCacheKey: "stable-session",
      contextSize: 8_192,
    })
    expect(prepared.request.providerOptions?.openai).toMatchObject({ promptCacheKey: "stable-session" })
    expect(prepared.packed.dropped).toBe(1)
    expect(prepared.request.messages.at(-1)).toEqual(Message.user("new task"))
  })

  /**
   * 🔴 **A PACKED SET THAT IS OVER ITS OWN BUDGET MUST SAY SO.** Three rules are deliberately
   * allowed to exceed `budgetTokens` — the newest message is always kept, the newest
   * assistant+results group is recovered whole, and the original task is re-prepended — and until
   * this finding existed nothing recorded the overrun. Measured 2026-09-14 (`ses_daedalus`): the
   * harness dispatched a request its own estimate put at 281,140 tokens against a 235,929 ceiling
   * and read back HTTP 400. A silent overrun is how a measured fault reaches a provider.
   */
  test("a kept set that could not be packed under budget reports the overrun", () => {
    const newest = Message.user("x".repeat(40_000))
    const packed = ContextPack.pack([Message.user("an older task"), newest], 1_000)
    expect(packed.fits).toBe(false)
    expect(packed.estimatedTokens).toBeGreaterThan(1_000)
    expect(packed.findings.find((finding) => finding.kind === "budget-overrun")).toMatchObject({
      kind: "budget-overrun",
      limitTokens: 1_000,
      keptMessages: 1,
      droppedMessages: 1,
    })
  })

  /**
   * ⚠️ **`hard` is for the last moment before dispatch and nothing else.** The three never-drop rules
   * are right for packing, but each can leave the request over the window by construction — and a
   * request over the window is a guaranteed 400, not a preference to be weighed. Here the ANCHOR is
   * what pushed the set over: with the rules relaxed, the same pack fits.
   */
  test("hard mode gives up the original-task anchor rather than dispatch an over-window request", () => {
    // The anchor is the ONLY thing over: the newest message fits the budget on its own, and the sole
    // real user message is four times the budget — so the choice is that anchor or a legal request.
    const messages = [Message.user("T".repeat(8_000)), Message.assistant("a".repeat(2_000))]
    const ordinary = ContextPack.pack(messages, 1_000)
    expect(ordinary.fits).toBe(false)
    expect(ordinary.messages.some((message) => message.role === "user")).toBe(true)

    const hard = ContextPack.pack(messages, 1_000, { hard: true })
    expect(hard.fits).toBe(true)
    expect(hard.messages).toEqual([Message.assistant("a".repeat(2_000))])
  })

  /**
   * The anchor is the NEWEST real user message, not the oldest. `find` returned the first one in
   * history — on a long chat that is the opening request, furthest from the work in flight and the
   * most expensive thing to re-prepend, and it displaced the task actually in force.
   */
  test("the re-prepended anchor is the newest task, not the opening one", () => {
    const packed = ContextPack.pack(
      [Message.user("O".repeat(8_000)), Message.user("N".repeat(8_000)), Message.assistant("a".repeat(2_000))],
      1_000,
    )
    expect(packed.messages[0]).toEqual(Message.user("N".repeat(8_000)))
    expect(packed.messages.filter((message) => message.role === "user")).toHaveLength(1)
  })

  /**
   * P7 — the packer must reserve the SAME response budget the compactor does. At a 262,144 window
   * both formulas give 26,215 and they agree by accident; at a smaller window the packer's own 10 %
   * is smaller than the configured 20,000 buffer, so it would approve a request the compactor has
   * already measured as over budget.
   */
  test("the packer reserves the compactor's response budget, not only its own 10%", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    // A window large enough to honor the full buffer. Small windows deliberately scale it down.
    const request = LLM.request({ model, messages: [Message.user("old".repeat(145_000)), Message.user("new task")] })
    const base = ProviderDispatch.prepare({ request, promptCacheKey: "s", contextSize: 128_000 })
    const reserved = ProviderDispatch.prepare({
      request,
      promptCacheKey: "s",
      contextSize: 128_000,
      minimumResponseReserveTokens: 20_000,
    })
    expect(base.packed.dropped).toBe(0)
    expect(reserved.packed.dropped).toBe(1)
    expect(reserved.packed.messages.at(-1)).toEqual(Message.user("new task"))
  })

  test("does not mistake exact-route prefix retention for semantic capacity", () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const request = LLM.request({
      model,
      messages: [Message.user("old".repeat(20_000)), Message.user("new task")],
    })
    const ordinary = ProviderDispatch.prepare({ request, promptCacheKey: "stable-session", contextSize: 64_000 })
    const retained = ProviderDispatch.prepare({
      request,
      promptCacheKey: "stable-session",
      contextSize: 64_000,
      prefixCacheRetentionTokens: 1_000,
    })

    expect(ordinary.packed.dropped).toBe(0)
    expect(retained.packed.dropped).toBe(0)
    expect(retained.packed.contextSize).toBe(64_000)
    expect(retained.request.messages).toEqual(ordinary.request.messages)
    expect(retained.request.messages.at(-1)).toEqual(Message.user("new task"))
  })

  test("a budgeted second turn reuses its opening anchor without adding a controller line", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const budget = 64
    const contextSize = 10_000
    const scope: PromptEstimate.Scope = {
      sessionID: "ses_budgeted_anchor" as SessionSchema.ID,
      contextEpoch: 1,
      providerID: "fake",
      modelID: "fake",
      serverKey: "http://fake.test/v1",
      routeID: "openai-chat",
      protocolID: "openai-chat",
      controllerKey: `reasoning-budget:${budget}`,
    }
    const firstBase = LLM.request({
      model,
      system: [SystemPart.make("stable controller test rules")],
      messages: [Message.user("first")],
    })
    const firstOpening = ProviderDispatch.openingRequest({ request: firstBase, enabled: true, budget })
    const firstEstimate = PromptEstimate.resolve({ request: firstOpening, messages: [], scope })
    const firstPrepared = ProviderDispatch.prepare({
      request: firstOpening,
      promptCacheKey: "stable-session",
      contextSize,
      promptCorrectionTokens: firstEstimate.correctionTokens,
      promptMarginTokens: firstEstimate.marginTokens,
    })
    expect(firstPrepared.packed.changed).toBe(false)
    const anchor = PromptEstimate.observe({
      request: firstPrepared.request,
      usage: new Usage({
        inputTokens: PromptEstimate.whole(firstPrepared.request),
        outputTokens: 1,
        nonCachedInputTokens: PromptEstimate.whole(firstPrepared.request),
      }),
      scope,
    })!

    const anchoredTranscript = [
      { type: "assistant", context: { promptAnchor: anchor } },
    ] as unknown as readonly SessionMessage.Message[]
    const plainSystem = firstBase.system
    const openingSystem = firstOpening.system
    const controllerTokens =
      ContextPack.estimateMessages(firstOpening.messages) - ContextPack.estimateMessages(firstBase.messages)
    const packingInput = {
      contextSize,
      tools: firstBase.tools,
      promptMarginTokens: firstEstimate.marginTokens,
    }
    const plainHistoryBudget = ContextPack.budget({ ...packingInput, system: plainSystem })
    const openingHistoryBudget = ContextPack.budget({ ...packingInput, system: openingSystem }) - controllerTokens
    expect(openingSystem).toEqual(plainSystem)
    expect(controllerTokens).toBe(0)
    expect(openingHistoryBudget).toBe(plainHistoryBudget)

    const historyFor = (length: number) => [
      Message.user("first"),
      Message.assistant("x".repeat(length)),
      Message.user("second"),
    ]
    let below = 0
    let above = 1
    while (ContextPack.estimateMessages(historyFor(above)) <= openingHistoryBudget) above *= 2
    while (above - below > 1) {
      const middle = Math.floor((above + below) / 2)
      if (ContextPack.estimateMessages(historyFor(middle)) <= openingHistoryBudget) below = middle
      else above = middle
    }
    const secondMessages = historyFor(above)
    expect(ContextPack.estimateMessages(historyFor(below))).toBeLessThanOrEqual(openingHistoryBudget)
    expect(ContextPack.estimateMessages(secondMessages)).toBeGreaterThan(plainHistoryBudget)

    const secondBase = LLM.request({ model, system: plainSystem, messages: secondMessages })
    const secondOpening = ProviderDispatch.openingRequest({ request: secondBase, enabled: true, budget })
    const secondEstimate = PromptEstimate.resolve({
      request: secondOpening,
      messages: anchoredTranscript,
      scope,
    })
    expect(secondEstimate.fallback).toBe("none")
    expect(secondEstimate.confidence).not.toBe("whole")
    expect(secondEstimate.anchorHeuristicTokens).toBe(anchor.heuristicTokens)

    const plainPacked = ProviderDispatch.prepare({
      request: secondBase,
      promptCacheKey: "stable-session",
      contextSize,
      promptCorrectionTokens: secondEstimate.correctionTokens,
      promptMarginTokens: secondEstimate.marginTokens,
    })
    const openingPacked = ProviderDispatch.prepare({
      request: secondOpening,
      promptCacheKey: "stable-session",
      contextSize,
      promptCorrectionTokens: secondEstimate.correctionTokens,
      promptMarginTokens: secondEstimate.marginTokens,
    })
    expect(plainPacked.packed.dropped).toBe(1)
    expect(openingPacked.packed.dropped).toBe(1)
    expect(openingPacked.request).toEqual(plainPacked.request)

    const dispatched: LLMRequest[] = []
    const llm = {
      stream: (request: LLMRequest) => {
        dispatched.push(request)
        return Stream.fromIterable([
          LLMEvent.textDelta({ id: "text-0", text: "OK" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        ])
      },
    } as never
    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: openingPacked.request,
        preparedOpening: openingPacked.request,
        enabled: true,
        budget,
      }).pipe(Stream.runDrain),
    )
    expect(dispatched).toEqual([openingPacked.request])
    expect(JSON.stringify(dispatched[0]!.messages)).not.toContain(`reasoning budget of about ${budget} tokens`)
  })

  test("routes an enabled completion through the reasoning controller", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const observed: Array<{
      request: LLMRequest
      usage: unknown
      anchorable: boolean
      phase: "reasoning" | "answer"
    }> = []
    const usage = {
      inputTokens: 42,
      outputTokens: 2,
      nonCachedInputTokens: 30,
      cacheReadInputTokens: 12,
    }
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "text-0" }),
          LLMEvent.textDelta({ id: "text-0", text: "OK" }),
          LLMEvent.textEnd({ id: "text-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
        ])
      },
    } as never
    const baseRequest = LLM.request({ model, messages: [Message.user("answer")] })
    const opening = ProviderDispatch.openingRequest({ request: baseRequest, enabled: true, budget: 64 })
    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: baseRequest,
        enabled: true,
        budget: 64,
        onProviderStep: (step) =>
          Effect.sync(() => {
            observed.push(step)
          }),
      }).pipe(Stream.runDrain),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]).toEqual(opening)
    expect(requests[0]!.messages).toEqual(baseRequest.messages)
    expect(observed).toHaveLength(1)
    expect(observed[0]!.request).toBe(requests[0])
    expect(observed[0]!.usage).toEqual(usage)
    expect(observed[0]!.anchorable).toBe(true)
    expect(observed[0]!.phase).toBe("answer")
  })

  test("keeps per-phase observations while the controller emits honest aggregate usage and servedBy", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const output: LLMEvent[] = []
    const observed: Array<{
      usage: Usage | undefined
      providerMetadata: Readonly<Record<string, unknown>> | undefined
    }> = []
    const firstUsage = new Usage({
      inputTokens: 120,
      outputTokens: 20,
      nonCachedInputTokens: 30,
      cacheReadInputTokens: 80,
      cacheWriteInputTokens: 10,
      reasoningTokens: 5,
      totalTokens: 140,
    })
    const finalUsage = new Usage({
      inputTokens: 180,
      outputTokens: 40,
      nonCachedInputTokens: 40,
      cacheReadInputTokens: 120,
      cacheWriteInputTokens: 20,
      reasoningTokens: 15,
      totalTokens: 220,
    })
    const firstMetadata = { openai: { system_fingerprint: "served-first" } }
    const finalMetadata = { openai: { system_fingerprint: "served-final" } }
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        const usage = requests.length === 1 ? firstUsage : finalUsage
        const providerMetadata = requests.length === 1 ? firstMetadata : finalMetadata
        return Stream.fromIterable([
          ...(requests.length === 1
            ? [LLMEvent.reasoningDelta({ id: "reasoning-0", text: "brief thought" })]
            : [LLMEvent.textDelta({ id: "text-0", text: "answer" })]),
          LLMEvent.stepFinish({ index: 0, reason: "stop", usage, providerMetadata }),
          LLMEvent.finish({ reason: "stop", usage, providerMetadata }),
        ])
      },
    } as never

    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: LLM.request({ model, messages: [Message.user("answer")] }),
        enabled: true,
        budget: 1_000,
        onProviderStep: (step) =>
          Effect.sync(() => {
            observed.push({ usage: step.usage, providerMetadata: step.providerMetadata })
          }),
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            output.push(event)
          }),
        ),
      ),
    )

    expect(requests).toHaveLength(2)
    expect(observed).toEqual([
      { usage: firstUsage, providerMetadata: firstMetadata },
      { usage: finalUsage, providerMetadata: finalMetadata },
    ])
    const terminals = output.filter((event) => LLMEvent.is.stepFinish(event) || LLMEvent.is.finish(event))
    expect(terminals.map((event) => event.type)).toEqual(["step-finish", "finish"])
    expect(terminals.map((event) => ProviderCapability.servingIdentityOf(event.providerMetadata))).toEqual([
      "served-final",
      "served-final",
    ])
    for (const terminal of terminals) {
      expect(terminal.usage).toMatchObject({
        inputTokens: 300,
        outputTokens: 60,
        nonCachedInputTokens: 70,
        cacheReadInputTokens: 200,
        cacheWriteInputTokens: 30,
        reasoningTokens: 20,
        totalTokens: 360,
      })
    }
  })

  test("observes a settled response even when the provider reports no usage", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const request = LLM.request({ model, messages: [Message.user("answer")] })
    const observed: Array<{
      request: LLMRequest
      usage: unknown
      anchorable: boolean
      phase: "reasoning" | "answer"
    }> = []
    const llm = {
      stream: () => Stream.fromIterable([LLMEvent.stepFinish({ index: 0, reason: "stop" })]),
    } as never

    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request,
        enabled: false,
        budget: 0,
        onProviderStep: (step) =>
          Effect.sync(() => {
            observed.push(step)
          }),
      }).pipe(Stream.runDrain),
    )

    expect(observed).toEqual([{ request, usage: undefined, anchorable: true, phase: "answer" }])
  })

  test("observes the exact settled continuation request below the reasoning controller", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const observed: Array<{
      request: LLMRequest
      usage: unknown
      anchorable: boolean
      phase: "reasoning" | "answer"
    }> = []
    const usage = { inputTokens: 50, outputTokens: 2, nonCachedInputTokens: 50 }
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return requests.length === 1
          ? Stream.fromIterable([LLMEvent.reasoningDelta({ id: "reasoning-0", text: "r".repeat(40) })])
          : Stream.fromIterable([
              LLMEvent.textDelta({ id: "text-0", text: "OK" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage }),
            ])
      },
    } as never

    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: LLM.request({ model, messages: [Message.user("answer")] }),
        enabled: true,
        budget: 8,
        onProviderStep: (step) =>
          Effect.sync(() => {
            observed.push(step)
          }),
      }).pipe(Stream.runDrain),
    )

    expect(requests).toHaveLength(2)
    expect(observed).toEqual([{ request: requests[1], usage, anchorable: false, phase: "answer" }])
    expect(requests[1]!.http?.body?.continue_final_message).toBe(true)
  })

  test("a distinct reasoning model runs in a harness-opened phase before the ordinary answer", async () => {
    const ordinary = Model.make({ id: "small", provider: "fake", route: OpenAIChat.route })
    const reasoner = Model.make({ id: "large", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const events: LLMEvent[] = []
    const phases: string[] = []
    let repacked = false
    const reasoningUsage = new Usage({ inputTokens: 8, outputTokens: 4, totalTokens: 12 })
    const answerUsage = new Usage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 })
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return request.model.id === reasoner.id
          ? Stream.fromIterable([
              LLMEvent.reasoningDelta({ id: "raw-reasoning", text: "check the two constraints" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage: reasoningUsage }),
            ])
          : Stream.fromIterable([
              LLMEvent.textDelta({ id: "text-0", text: "Final answer" }),
              LLMEvent.stepFinish({ index: 0, reason: "stop", usage: answerUsage }),
            ])
      },
    } as never

    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: LLM.request({ model: ordinary, messages: [Message.user("solve this")] }),
        enabled: true,
        budget: 128,
        reasoningModel: reasoner,
        reasoningPhase: {
          enter: Effect.sync(() => phases.push("reasoning-admitted")),
          leave: (cost) => Effect.sync(() => phases.push(`reasoning-released:${cost}`)),
        },
        prepareAnswer: (answer) => {
          repacked = true
          return answer
        },
      }).pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event)
          }),
        ),
      ),
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]!.model.id).toBe(reasoner.id)
    expect(requests[0]!.messages.at(-1)).toEqual(Message.assistant("<think>\n"))
    expect(requests[1]!.model.id).toBe(ordinary.id)
    expect(requests[1]!.http?.body?.chat_template_kwargs).toMatchObject({ enable_thinking: false })
    expect(JSON.stringify(requests[1]!.messages.at(-1))).toContain("check the two constraints")
    expect(repacked).toBe(true)
    expect(phases).toEqual(["reasoning-admitted", "reasoning-released:12"])
    const terminal = events.find(LLMEvent.is.stepFinish)
    expect(terminal?.usage).toMatchObject({ inputTokens: 18, outputTokens: 7, totalTokens: 25 })
  })

  test("revoking the private reasoning device ends that phase and continues on the answer device", async () => {
    const ordinary = Model.make({ id: "answer", provider: "fake", route: OpenAIChat.route })
    const reasoner = Model.make({ id: "reasoner", provider: "fake", route: OpenAIChat.route })
    let released = false
    const output = await Effect.runPromise(ProviderDispatch.stream({
      llm: {
        stream: (request: LLMRequest) => request.model.id === reasoner.id
          ? Stream.fromEffect(Effect.never)
          : Stream.make(LLMEvent.textDelta({ id: "answer", text: "Ready" })),
      } as never,
      request: LLM.request({ model: ordinary, messages: [Message.user("solve")] }),
      enabled: true,
      budget: 128,
      reasoningModel: reasoner,
      reasoningPhase: {
        enter: Effect.void,
        leave: () => Effect.sync(() => { released = true }),
        revocation: Effect.void,
      },
    }).pipe(Stream.runCollect, Effect.timeout(1_000)))
    expect(released).toBe(true)
    expect(Array.from(output)).toEqual([LLMEvent.textDelta({ id: "answer", text: "Ready" })])
  })

  test("admits once, retries before output, and always releases", async () => {
    const sessionID = "ses_dispatch" as SessionSchema.ID
    const calls: string[] = []
    let attempts = 0
    const timing: string[] = []
    const scheduler = {
      admit: () => Effect.sync(() => calls.push("admit")),
      release: () => Effect.sync(() => calls.push("release")),
      awaitRevocation: () => Effect.never,
      report: ({ costTokens }: { costTokens: number }) => Effect.sync(() => calls.push(`report:${costTokens}`)),
    } as never
    const result = await Effect.runPromise(
      ProviderDispatch.run({
        events,
        scheduler,
        sessionID,
        slot: {
          sessionID,
          deviceKey: "device",
          sessionClass: "interactive-focused",
        },
        maxAttempts: 2,
        hasOutput: () => false,
        costTokens: () => 12,
        attempt: Effect.suspend(() => {
          attempts++
          return attempts === 1 ? Effect.fail(immediateTransient()) : Effect.void
        }),
        timing: {
          queued: () => timing.push("queued"),
          admitted: () => timing.push("admitted"),
          attemptStarted: (attempt) => timing.push(`start:${attempt}`),
          attemptSettled: (attempt, outcome) => timing.push(`end:${attempt}:${outcome}`),
        },
      }),
    )
    expect(result._tag).toBe("Success")
    expect(attempts).toBe(2)
    // TWO releases, and the order is the point: charge the ledger, release the device IN BAND, then
    // the `ensuring` net fires a second, idempotent release. The in-band one is what stops a parent
    // holding the device through settlement — see the deadlock repro in
    // `test/session-scheduler-concurrency.test.ts`.
    expect(calls).toEqual(["admit", "report:12", "release", "release"])
    expect(timing).toEqual(["queued", "admitted", "start:1", "end:1:retry", "start:2", "end:2:completed"])
  })

  test("lowering capacity cuts off the excess provider request and frees its slot", async () => {
    const scheduler = SessionScheduler.make()
    const first = { sessionID: "first", deviceKey: "device", sessionClass: "auto-prompting" as const, concurrency: 2 }
    const second = { sessionID: "second", deviceKey: "device", sessionClass: "auto-prompting" as const, concurrency: 2 }
    let completeFirst!: () => void
    const firstDone = new Promise<void>((resolve) => { completeFirst = resolve })
    const dispatch = (slot: typeof first) => ProviderDispatch.run({
      events,
      scheduler,
      sessionID: slot.sessionID as SessionSchema.ID,
      slot,
      maxAttempts: 1,
      hasOutput: () => false,
      attempt: slot.sessionID === "first" ? Effect.promise(() => firstDone) : Effect.never,
    })
    const firstFiber = Effect.runFork(dispatch(first))
    const secondFiber = Effect.runFork(dispatch(second))
    for (let i = 0; i < 50; i++) {
      if ((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightBatch.length === 2) break
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightBatch).toEqual(["first", "second"])
    await Effect.runPromise(scheduler.syncDevices({ device: { concurrency: 1 } }))
    const outcome = await Effect.runPromise(Fiber.join(secondFiber))
    expect(outcome._tag).toBe("Failure")
    expect((await Effect.runPromise(scheduler.snapshot()))[0]?.inFlightBatch).toEqual(["first"])
    completeFirst()
    await Effect.runPromise(Fiber.join(firstFiber))
  })

  test("the configured runner budget is the exact HTTP wire-request budget", async () => {
    const sessionID = "ses_exact_wire_budget" as SessionSchema.ID
    let wireRequests = 0
    const scheduler = {
      admit: () => Effect.void,
      release: () => Effect.void,
      awaitRevocation: () => Effect.never,
      report: () => Effect.void,
    } as never
    const httpLayer = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.sync(() => {
          wireRequests++
          return HttpClientResponse.fromWeb(
            request,
            new Response("server restarting", { status: 503, headers: { "retry-after-ms": "0" } }),
          )
        }),
      ),
    )
    const executorLayer = RequestExecutor.layer.pipe(Layer.provide(httpLayer))

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const executor = yield* RequestExecutor.Service
        return yield* ProviderDispatch.run({
          events,
          scheduler,
          sessionID,
          slot: { sessionID, deviceKey: "device", sessionClass: "interactive-focused" },
          maxAttempts: 3,
          hasOutput: () => false,
          attempt: executor.execute(HttpClientRequest.get("https://provider.test/v1/chat")).pipe(Effect.asVoid),
        })
      }).pipe(Effect.provide(executorLayer)),
    )

    expect(result._tag).toBe("Failure")
    expect(wireRequests).toBe(3)
  })

  test("publishes server-owned live timing at scheduler and provider boundaries", async () => {
    const sessionID = "ses_live_timing" as SessionSchema.ID
    const statuses: Array<{ type: string; timing?: SessionMessage.TurnTiming }> = []
    let reads = 0
    const liveEvents = {
      publish: (_event: unknown, data: { status?: { type: string; timing?: SessionMessage.TurnTiming } }) =>
        Effect.sync(() => {
          if (data.status) statuses.push(data.status)
        }),
    } as never
    const scheduler = {
      admit: () => Effect.void,
      release: () => Effect.void,
      awaitRevocation: () => Effect.never,
      report: () => Effect.void,
    } as never

    await Effect.runPromise(
      ProviderDispatch.run({
        events: liveEvents,
        scheduler,
        sessionID,
        slot: { sessionID, deviceKey: "device", sessionClass: "interactive-focused" },
        maxAttempts: 1,
        hasOutput: () => false,
        attempt: Effect.void,
        timing: {
          live: () => ({ startedAt: ++reads, phases: [], providerAttempts: [] }),
        },
      }),
    )

    expect(statuses).toEqual([
      { type: "busy", timing: { startedAt: 1, phases: [], providerAttempts: [] } },
      { type: "busy", timing: { startedAt: 2, phases: [], providerAttempts: [] } },
      { type: "busy", timing: { startedAt: 3, phases: [], providerAttempts: [] } },
      { type: "busy", timing: { startedAt: 4, phases: [], providerAttempts: [] } },
    ])
  })

  test("never replays after output and still releases the slot", async () => {
    const sessionID = "ses_dispatch" as SessionSchema.ID
    const calls: string[] = []
    let attempts = 0
    const scheduler = {
      admit: () => Effect.sync(() => calls.push("admit")),
      release: () => Effect.sync(() => calls.push("release")),
      awaitRevocation: () => Effect.never,
      report: () => Effect.sync(() => calls.push("report")),
    } as never
    const result = await Effect.runPromise(
      ProviderDispatch.run({
        events,
        scheduler,
        sessionID,
        slot: {
          sessionID,
          deviceKey: "device",
          sessionClass: "interactive-focused",
        },
        maxAttempts: 3,
        hasOutput: () => true,
        attempt: Effect.suspend(() => {
          attempts++
          return Effect.fail(transient())
        }),
      }),
    )
    expect(result._tag).toBe("Failure")
    expect(attempts).toBe(1)
    // Same two releases here. `scheduler.release` is gated on `held`, so the net is a no-op after the
    // in-band call — the duplicate is deliberate, not a leak.
    expect(calls).toEqual(["admit", "release", "release"])
  })
})
