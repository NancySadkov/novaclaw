import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import fs from "node:fs"
import path from "node:path"
import {
  LLM,
  LLMError,
  LLMEvent,
  Message,
  Model,
  RateLimitReason,
  TransportReason,
  type LLMRequest,
} from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { SessionSchema } from "../schema"
import type { SessionMessage } from "@novaclaw/schema/session-message"
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

  test("packs to a tighter exact-route prefix-retention ceiling", () => {
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
    expect(retained.packed.dropped).toBe(1)
    expect(retained.packed.contextSize).toBe(64_000)
    expect(retained.request.messages.at(-1)).toEqual(Message.user("new task"))
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
