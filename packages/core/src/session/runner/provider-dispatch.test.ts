import { describe, expect, test } from "bun:test"
import { Effect, Layer, Stream } from "effect"
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

  test("a budgeted second turn reuses its opening anchor and packs the controller line before dispatch", async () => {
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
    const controllerLine = firstOpening.system.at(-1)!
    const plainSystem = firstBase.system
    const openingSystem = firstOpening.system
    const controllerTokens = Token.estimate(controllerLine.text)
    const packingInput = {
      contextSize,
      tools: firstBase.tools,
      promptMarginTokens: firstEstimate.marginTokens,
    }
    const plainHistoryBudget = ContextPack.budget({ ...packingInput, system: plainSystem })
    const openingHistoryBudget = ContextPack.budget({ ...packingInput, system: openingSystem })
    expect(plainHistoryBudget - openingHistoryBudget).toBe(controllerTokens)

    let filler = ""
    let secondMessages = [Message.user("first"), Message.assistant(filler), Message.user("second")]
    while (ContextPack.estimateMessages(secondMessages) <= openingHistoryBudget) {
      filler += "x"
      secondMessages = [Message.user("first"), Message.assistant(filler), Message.user("second")]
    }
    expect(ContextPack.estimateMessages(secondMessages)).toBeLessThanOrEqual(plainHistoryBudget)

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
    expect(plainPacked.packed.dropped).toBe(0)
    expect(openingPacked.packed.dropped).toBe(1)

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
    expect(
      dispatched[0]!.system.filter((part) => part.text.includes(`reasoning budget of about ${budget} tokens`)),
    ).toHaveLength(1)
  })

  test("routes an enabled completion through the reasoning controller", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const observed: Array<{ request: LLMRequest; usage: unknown; anchorable: boolean }> = []
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
    expect(requests[0]!.system.at(-1)?.text).toContain("reasoning budget of about 64 tokens")
    expect(observed).toHaveLength(1)
    expect(observed[0]!.request).toBe(requests[0])
    expect(observed[0]!.usage).toEqual(usage)
    expect(observed[0]!.anchorable).toBe(true)
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
    const observed: Array<{ request: LLMRequest; usage: unknown; anchorable: boolean }> = []
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

    expect(observed).toEqual([{ request, usage: undefined, anchorable: true }])
  })

  test("observes the exact settled continuation request below the reasoning controller", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const observed: Array<{ request: LLMRequest; usage: unknown; anchorable: boolean }> = []
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
    expect(observed).toEqual([{ request: requests[1], usage, anchorable: false }])
    expect(requests[1]!.http?.body?.continue_final_message).toBe(true)
  })

  test("admits once, retries before output, and always releases", async () => {
    const sessionID = "ses_dispatch" as SessionSchema.ID
    const calls: string[] = []
    let attempts = 0
    const timing: string[] = []
    const scheduler = {
      admit: () => Effect.sync(() => calls.push("admit")),
      release: () => Effect.sync(() => calls.push("release")),
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
          sessionClass: "interactive",
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

  test("the configured runner budget is the exact HTTP wire-request budget", async () => {
    const sessionID = "ses_exact_wire_budget" as SessionSchema.ID
    let wireRequests = 0
    const scheduler = {
      admit: () => Effect.void,
      release: () => Effect.void,
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
          slot: { sessionID, deviceKey: "device", sessionClass: "interactive" },
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
      report: () => Effect.void,
    } as never

    await Effect.runPromise(
      ProviderDispatch.run({
        events: liveEvents,
        scheduler,
        sessionID,
        slot: { sessionID, deviceKey: "device", sessionClass: "interactive" },
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
          sessionClass: "interactive",
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
