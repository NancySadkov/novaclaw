import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import { DateTime } from "effect"
import { LLM, Message, Model, SystemPart, Usage } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
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

const imageRequest = (text: string) => {
  const header = Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    0,
    0,
    0,
    13,
    0x49,
    0x48,
    0x44,
    0x52,
    0,
    0,
    0x04,
    0, // width = 1024
    0,
    0,
    0x03,
    0, // height = 768
    ...Array(40).fill(0),
  ])
  return LLM.request({
    model,
    system: [SystemPart.make("rules")],
    messages: [
      Message.user([
        { type: "text", text },
        { type: "media", mediaType: "image/png", data: Buffer.from(header).toString("base64") },
      ]),
    ],
  })
}

const scope = (over: Partial<PromptEstimate.Scope> = {}): PromptEstimate.Scope => ({
  sessionID,
  contextEpoch: 7,
  providerID: "wire-provider",
  modelID: "wire-model",
  serverKey: "http://server/v1",
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
      marginTokens: 1_000,
      confidence: "whole",
      fallback: "unavailable",
    })
  })

  test("keeps response reserve and adaptive estimation margin as separate quantities", () => {
    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 120, outputTokens: 1, nonCachedInputTokens: 120 }),
      scope: scope(),
    })!
    const current = request("x".repeat(400_000))
    const result = PromptEstimate.resolve({
      request: current,
      messages: [assistant(anchor)],
      scope: scope(),
      anchoredResidualRatios: [0.8, 1.2, 0.8, 1.2, 0.8, 1.2, 0.8, 1.2],
    })
    const available = PromptEstimate.capacity({ contextTokens: 256_000, outputTokens: 32_000 })

    expect(result.marginTokens / result.estimatedTokens).toBeCloseTo(0.3, 4)
    expect(available).toEqual({
      contextTokens: 256_000,
      responseReserveTokens: 32_000,
      promptCeilingTokens: 224_000,
    })
    expect(PromptEstimate.withMargin(result)).toBe(result.estimatedTokens + result.marginTokens)
  })

  test("a declared response at least as large as the context leaves a zero prompt ceiling", () => {
    expect(PromptEstimate.capacity({ contextTokens: 32_000, outputTokens: 32_000 }).promptCeilingTokens).toBe(0)
    expect(PromptEstimate.capacity({ contextTokens: 32_000, outputTokens: 64_000 })).toMatchObject({
      responseReserveTokens: 64_000,
      promptCeilingTokens: 0,
    })
  })

  test("keeps exact-route prefix retention informational rather than evicting semantic history", () => {
    expect(
      PromptEstimate.capacity({
        contextTokens: 256_000,
        outputTokens: 32_000,
        prefixCacheRetentionTokens: 130_000,
      }),
    ).toEqual({
      contextTokens: 256_000,
      responseReserveTokens: 32_000,
      prefixCacheRetentionTokens: 130_000,
      promptCeilingTokens: 224_000,
    })

    // The context limit still wins when it is tighter than the route's cache retention.
    expect(
      PromptEstimate.capacity({
        contextTokens: 64_000,
        outputTokens: 16_000,
        prefixCacheRetentionTokens: 100_000,
      }).promptCeilingTokens,
    ).toBe(48_000)

    const ordinary = PromptEstimate.capacity({ contextTokens: 64_000, outputTokens: 16_000 })
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 12.5])
      expect(
        PromptEstimate.capacity({
          contextTokens: 64_000,
          outputTokens: 16_000,
          prefixCacheRetentionTokens: invalid,
        }),
      ).toEqual(ordinary)
  })

  test("derives the automatic boundary from ninety percent of the resolved model window", () => {
    expect(PromptEstimate.capacity({ contextTokens: 262_144 })).toEqual({
      contextTokens: 262_144,
      responseReserveTokens: 26_215,
      promptCeilingTokens: 235_929,
    })
    expect(PromptEstimate.capacity({ contextTokens: 256_000 })).toEqual({
      contextTokens: 256_000,
      responseReserveTokens: 25_600,
      promptCeilingTokens: 230_400,
    })
  })

  test("does not mistake anchored residual spread for cold-start coverage", () => {
    const current = request("x".repeat(400_000))
    const result = PromptEstimate.resolve({
      request: current,
      messages: [],
      scope: scope(),
      anchoredResidualRatios: [0.8, 1.2, 0.8, 1.2],
    })
    expect(result.confidence).toBe("whole")
    expect(result.marginTokens).toBe(Math.ceil(result.estimatedTokens * 0.02))
  })

  test("applies route calibration one-sided to a whole request and caps hostile factors", () => {
    const current = request("dense 0123456789".repeat(200))
    const heuristic = PromptEstimate.whole(current)

    expect(
      PromptEstimate.resolve({ request: current, messages: [], scope: scope(), calibrationFactor: 1.2 })
        .estimatedTokens,
    ).toBe(Math.ceil(heuristic * 1.2))
    expect(
      PromptEstimate.resolve({ request: current, messages: [], scope: scope(), calibrationFactor: 0.5 })
        .estimatedTokens,
    ).toBe(heuristic)
    expect(
      PromptEstimate.resolve({ request: current, messages: [], scope: scope(), calibrationFactor: 99 }).estimatedTokens,
    ).toBe(Math.ceil(heuristic * 1.25))
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

  test("calibrates only positive growth beyond an exact anchor", () => {
    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 120, outputTokens: 1, nonCachedInputTokens: 120 }),
      scope: scope(),
    })!
    const current = request("old plus dense 0123456789".repeat(100))
    const delta = PromptEstimate.whole(current) - PromptEstimate.whole(previous)
    const result = PromptEstimate.resolve({
      request: current,
      messages: [assistant(anchor)],
      scope: scope(),
      calibrationFactor: 1.2,
    })

    expect(result.estimatedTokens).toBe(120 + Math.ceil(delta * 1.2))
    expect(result.correctionTokens).toBe(result.estimatedTokens - result.heuristicTokens)
  })

  test("uses one resolved non-default image grid for the whole estimate, anchor, and positive delta", () => {
    const imagePatchPixels = 64
    const previous = imageRequest("old")
    const current = imageRequest("old plus new material".repeat(40))
    const previousHeuristic = PromptEstimate.whole(previous, imagePatchPixels)
    const currentHeuristic = PromptEstimate.whole(current, imagePatchPixels)

    expect(previousHeuristic).toBeLessThan(PromptEstimate.whole(previous))
    expect(PromptEstimate.unsupported(previous, imagePatchPixels).heuristicTokens).toBe(previousHeuristic)
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 500, outputTokens: 1, nonCachedInputTokens: 500 }),
      scope: scope(),
      imagePatchPixels,
    })!
    expect(anchor.heuristicTokens).toBe(previousHeuristic)

    const delta = currentHeuristic - previousHeuristic
    expect(delta).toBeGreaterThan(0)
    const result = PromptEstimate.resolve({
      request: current,
      messages: [assistant(anchor)],
      scope: scope(),
      imagePatchPixels,
    })
    expect(result.heuristicTokens).toBe(currentHeuristic)
    expect(result.anchorHeuristicTokens).toBe(previousHeuristic)
    expect(result.deltaTokens).toBe(delta)
    expect(result.estimatedTokens).toBe(500 + delta)
    expect(result.correctionTokens).toBe(result.estimatedTokens - currentHeuristic)
  })

  test("falls back to the whole request when the image grid changes on the same route", () => {
    const current = imageRequest("same request")
    const anchor = PromptEstimate.observe({
      request: current,
      usage: new Usage({ inputTokens: 500, outputTokens: 1, nonCachedInputTokens: 500 }),
      scope: scope(),
      imagePatchPixels: 64,
    })!
    const heuristicTokens = PromptEstimate.whole(current, 32)

    expect(anchor.heuristicTokens).not.toBe(heuristicTokens)
    const result = PromptEstimate.resolve({
      request: current,
      messages: [assistant(anchor)],
      scope: scope(),
      imagePatchPixels: 32,
    })
    expect(result).toMatchObject({
      heuristicTokens,
      estimatedTokens: heuristicTokens,
      fallback: "shape-changed",
      confidence: "whole",
      anchorReportedTokens: 0,
      anchorHeuristicTokens: 0,
    })
  })

  test("invalidates an anchor when effective chat-template options change", () => {
    const cases = [
      [
        { chat_template_kwargs: { enable_thinking: false } },
        { chat_template_kwargs: { enable_thinking: true } },
      ],
      [{ continue_final_message: false }, { continue_final_message: true }],
      [{ add_generation_prompt: true }, { add_generation_prompt: false }],
    ] as const

    for (const [before, after] of cases) {
      const previous = LLM.request({
        model,
        system: [SystemPart.make("rules")],
        messages: [Message.user("same prompt")],
        http: { body: before },
      })
      const anchor = PromptEstimate.observe({
        request: previous,
        usage: new Usage({ inputTokens: 100, outputTokens: 1, nonCachedInputTokens: 100 }),
        scope: scope(),
      })!
      const current = LLM.request({
        model,
        system: previous.system,
        messages: previous.messages,
        http: { body: after },
      })

      expect(PromptEstimate.resolve({ request: current, messages: [assistant(anchor)], scope: scope() })).toMatchObject({
        confidence: "whole",
        fallback: "shape-changed",
      })
    }
  })

  test("normalizes template options across HTTP precedence and object key order", () => {
    const inheritedModel = Model.make({
      id: "wire-model",
      provider: "wire-provider",
      route: OpenAIChat.route.with({
        http: {
          body: {
            add_generation_prompt: true,
            chat_template_kwargs: { format: "jinja", enable_thinking: true },
          },
        },
      }),
      defaults: { http: { body: { chat_template_kwargs: { enable_thinking: false } } } },
    })
    const inherited = LLM.request({
      model: inheritedModel,
      system: [SystemPart.make("rules")],
      messages: [Message.user("same prompt")],
    })
    const explicit = LLM.request({
      model,
      system: inherited.system,
      messages: inherited.messages,
      http: {
        body: {
          chat_template_kwargs: { enable_thinking: false, format: "jinja" },
          add_generation_prompt: true,
        },
      },
    })

    expect(PromptEstimate.shapeKey(inherited)).toBe(PromptEstimate.shapeKey(explicit))
  })

  test("retains an anchor across sampling-only changes and excludes credentials from identity", () => {
    const previous = LLM.request({
      model,
      system: [SystemPart.make("rules")],
      messages: [Message.user("same prompt")],
      generation: { temperature: 0.2, topP: 0.8 },
      http: { headers: { Authorization: "Bearer secret-a" }, body: { apiKey: "secret-a", min_p: 0.1 } },
    })
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 100, outputTokens: 1, nonCachedInputTokens: 100 }),
      scope: scope(),
    })!
    const current = LLM.request({
      model,
      system: previous.system,
      messages: previous.messages,
      generation: { temperature: 1.1, topP: 0.95 },
      http: { headers: { Authorization: "Bearer secret-b" }, body: { apiKey: "secret-b", min_p: 0.7 } },
    })
    const result = PromptEstimate.resolve({ request: current, messages: [assistant(anchor)], scope: scope() })

    expect(PromptEstimate.shapeKey(previous)).toBe(PromptEstimate.shapeKey(current))
    expect(result.fallback).toBe("none")
    expect(result.confidence).not.toBe("whole")
  })

  test("does not reuse an anchor from a previous serving process behind the same URL", () => {
    const current = request("same endpoint, replacement process")
    const anchor = PromptEstimate.observe({
      request: current,
      usage: new Usage({ inputTokens: 500, outputTokens: 1, nonCachedInputTokens: 500 }),
      scope: scope({ servedBy: "process-a" }),
    })!

    expect(
      PromptEstimate.resolve({
        request: current,
        messages: [assistant(anchor)],
        scope: scope({ servedBy: "process-b" }),
      }).fallback,
    ).toBe("serving-process-changed")
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

  test("distinguishes endpoint processes that share one physical device", () => {
    const physicalDevice = "spark"
    const firstServer = PromptEstimate.serverKey("http://spark.local:8010/v1/", physicalDevice)
    const secondServer = PromptEstimate.serverKey("http://spark.local:8011/v1/", physicalDevice)
    expect(firstServer).toBe("http://spark.local:8010/v1")
    expect(secondServer).toBe("http://spark.local:8011/v1")
    expect(PromptEstimate.serverKey(undefined, physicalDevice)).toBe(physicalDevice)

    const previous = request("old")
    const anchor = PromptEstimate.observe({
      request: previous,
      usage: new Usage({ inputTokens: 100, outputTokens: 1, nonCachedInputTokens: 100 }),
      scope: scope({ serverKey: firstServer }),
    })!
    const result = PromptEstimate.resolve({
      request: request("new"),
      messages: [assistant(anchor)],
      scope: scope({ serverKey: secondServer }),
    })
    expect(result.confidence).toBe("whole")
    expect(result.fallback).toBe("server-changed")
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
      [{ variant: "other" }, "rules", "model-changed"],
      [{ serverKey: "other" }, "rules", "server-changed"],
      [{ routeID: "other" }, "rules", "route-changed"],
      [{ protocolID: "other" }, "rules", "protocol-changed"],
      [{ servedBy: "other" }, "rules", "serving-process-changed"],
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
