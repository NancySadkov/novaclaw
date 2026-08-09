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

  test("routes an enabled completion through the reasoning controller", async () => {
    const model = Model.make({ id: "fake", provider: "fake", route: OpenAIChat.route })
    const requests: LLMRequest[] = []
    const llm = {
      stream: (request: LLMRequest) => {
        requests.push(request)
        return Stream.fromIterable([
          LLMEvent.textStart({ id: "text-0" }),
          LLMEvent.textDelta({ id: "text-0", text: "OK" }),
          LLMEvent.textEnd({ id: "text-0" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        ])
      },
    } as never
    await Effect.runPromise(
      ProviderDispatch.stream({
        llm,
        request: LLM.request({ model, messages: [Message.user("answer")] }),
        enabled: true,
        budget: 64,
      }).pipe(Stream.runDrain),
    )
    expect(requests).toHaveLength(1)
    expect(requests[0]!.system.at(-1)?.text).toContain("reasoning budget of about 64 tokens")
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
    expect(calls).toEqual(["admit", "report:12", "release"])
    expect(timing).toEqual(["queued", "admitted", "start:1", "end:1:retry", "start:2", "end:2:completed"])
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
    expect(calls).toEqual(["admit", "release"])
  })
})
