import { describe, expect, test } from "bun:test"
import { DateTime } from "effect"
import { LLM, Message, Model, SystemPart, Usage } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-chat"
import { ModelV2 } from "../../model"
import { ProviderV2 } from "../../provider"
import { SessionMessage } from "../message"
import { SessionSchema } from "../schema"
import { PromptEstimate } from "./prompt-estimate"

const model = Model.make({ id: "wire-model", provider: "wire-provider", route: OpenAIChat.route })
const sessionID = SessionSchema.ID.make("ses_prompt_estimate")
const created = DateTime.makeUnsafe(0)
let messageIndex = 0

const request = (text: string, system = "rules") =>
  LLM.request({ model, system: [SystemPart.make(system)], messages: [Message.user(text)] })

const scope = (over: Partial<PromptEstimate.Scope> = {}): PromptEstimate.Scope => ({
  sessionID,
  contextEpoch: 7,
  providerID: "wire-provider",
  modelID: "wire-model",
  deviceKey: "http://device",
  routeID: "openai-chat",
  protocolID: "openai-chat",
  controllerKey: "plain",
  ...over,
})

const assistant = (anchor?: SessionMessage.PromptAnchor) =>
  SessionMessage.Assistant.make({
    id: SessionMessage.ID.make(`msg_prompt_estimate_${++messageIndex}`),
    type: "assistant",
    agent: "build",
    model: { id: ModelV2.ID.make("wire-model"), providerID: ProviderV2.ID.make("wire-provider") },
    content: [],
    context: {
      window: 32_000,
      estimatedTokens: 1,
      droppedMessages: 0,
      elidedOutputs: 0,
      findings: [],
      ...(anchor === undefined ? {} : { promptAnchor: anchor }),
    },
    time: { created, completed: created },
  })

describe("PromptEstimate", () => {
  test("without a compatible anchor, estimates the whole exact request", () => {
    const current = request("hello")
    const result = PromptEstimate.resolve({ request: current, messages: [], scope: scope() })
    expect(result).toMatchObject({
      heuristicTokens: PromptEstimate.whole(current),
      estimatedTokens: PromptEstimate.whole(current),
      correctionTokens: 0,
      confidence: "whole",
      fallback: "unavailable",
    })
  })

  test("adds the signed heuristic delta to the last provider-reported prompt count", () => {
    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 120, outputTokens: 1, nonCachedInputTokens: 120 }),
      scope: scope(),
    })!
    const current = request("old plus new material".repeat(20))
    const result = PromptEstimate.resolve({ request: current, messages: [assistant(anchor)], scope: scope() })
    const delta = PromptEstimate.whole(current) - PromptEstimate.whole(previous)
    expect(result.estimatedTokens).toBe(120 + delta)
    expect(result.deltaTokens).toBe(delta)
    expect(result.correctionTokens).toBe(120 - PromptEstimate.whole(previous))
    expect(result.fallback).toBe("none")
  })

  test("retains the last valid anchor across a settled response with no usage", () => {
    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 100, outputTokens: 1, nonCachedInputTokens: 100 }),
      scope: scope(),
    })!
    const result = PromptEstimate.resolve({
      request: request("old and new"),
      messages: [assistant(anchor), assistant()],
      scope: scope(),
    })
    expect(result.confidence).not.toBe("whole")
  })

  test("marks growth above 15 percent low-confidence without discarding the anchor", () => {
    const previous = request("x")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 20, outputTokens: 1, nonCachedInputTokens: 20 }),
      scope: scope(),
    })!
    const result = PromptEstimate.resolve({
      request: request("y".repeat(4_000)),
      messages: [assistant(anchor)],
      scope: scope(),
    })
    expect(result.growth).toBeGreaterThan(0.15)
    expect(result.confidence).toBe("low")
    expect(result.fallback).toBe("none")
  })

  test("a token-dense first request is recognized as larger than a chars/4 context", () => {
    const digits = "0123456789".repeat(3_300)
    const current = request(digits)
    const result = PromptEstimate.resolve({ request: current, messages: [], scope: scope() })
    expect(result.confidence).toBe("whole")
    expect(result.estimatedTokens).toBeGreaterThan(32_000)
    expect(result.estimatedTokens).toBeGreaterThan(digits.length / 4)
  })

  test("uses inclusive inputTokens once and rejects missing, zero, or contradictory usage", () => {
    expect(
      PromptEstimate.reportedPromptTokens(
        new Usage({
          inputTokens: 50,
          nonCachedInputTokens: 30,
          cacheReadInputTokens: 20,
          cacheWriteInputTokens: 0,
        }),
      ),
    ).toBe(50)
    expect(PromptEstimate.reportedPromptTokens(new Usage({ inputTokens: 0 }))).toBeUndefined()
    expect(PromptEstimate.reportedPromptTokens(new Usage({}))).toBeUndefined()
    expect(
      PromptEstimate.reportedPromptTokens(
        new Usage({
          inputTokens: 50,
          nonCachedInputTokens: 30,
          cacheReadInputTokens: 30,
          cacheWriteInputTokens: 0,
        }),
      ),
    ).toBeUndefined()
  })

  test("derives prompt tokens only from a complete positive breakdown when inputTokens is absent", () => {
    expect(
      PromptEstimate.reportedPromptTokens(
        new Usage({ nonCachedInputTokens: 30, cacheReadInputTokens: 12, cacheWriteInputTokens: 8 }),
      ),
    ).toBe(50)
    expect(
      PromptEstimate.reportedPromptTokens(new Usage({ nonCachedInputTokens: 30, cacheReadInputTokens: 12 })),
    ).toBeUndefined()
  })

  test("invalidates provider, model, server, route, protocol, controller, shape, epoch, and session changes", () => {
    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 100, outputTokens: 1, nonCachedInputTokens: 100 }),
      scope: scope(),
    })!
    const cases: Array<[Partial<PromptEstimate.Scope>, string, PromptEstimate.Fallback]> = [
      [{ providerID: "other" }, "rules", "provider-changed"],
      [{ modelID: "other" }, "rules", "model-changed"],
      [{ deviceKey: "other" }, "rules", "server-changed"],
      [{ routeID: "other" }, "rules", "route-changed"],
      [{ protocolID: "other" }, "rules", "protocol-changed"],
      [{ controllerKey: "other" }, "rules", "controller-changed"],
      [{ contextEpoch: 8 }, "rules", "epoch-changed"],
      [{ sessionID: SessionSchema.ID.make("ses_other") }, "rules", "session-changed"],
      [{}, "changed rules", "shape-changed"],
    ]
    for (const [over, system, fallback] of cases) {
      const current = request("new", system)
      const result = PromptEstimate.resolve({ request: current, messages: [assistant(anchor)], scope: scope(over) })
      expect(result.confidence, fallback).toBe("whole")
      expect(result.fallback, fallback).toBe(fallback)
    }
  })
})
