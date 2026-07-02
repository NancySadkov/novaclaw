import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import type { LLMRequest } from "../schema"
import { OpenAIChat } from "./openai-chat"

// `fromRequest` reads model/messages/tools/generation — a minimal cast drives the real
// body construction without a live model (same pattern as the recovery test).
const request = (generation: Record<string, unknown>) =>
  ({
    model: { id: "qwen3.6-35b" },
    system: [],
    messages: [],
    tools: [],
    generation,
  }) as unknown as LLMRequest

const body = (generation: Record<string, unknown>) =>
  Effect.runSync(OpenAIChat.protocol.body.from(request(generation))) as Record<string, unknown>

describe("openai-chat — sampling passthrough (1C)", () => {
  test("top_k reaches the provider body from generation.topK", () => {
    const result = body({ temperature: 0.6, topP: 0.95, topK: 20 })
    expect(result.top_k).toBe(20)
    expect(result.temperature).toBe(0.6)
    expect(result.top_p).toBe(0.95)
  })

  test("top_k is omitted when unset (api.openai.com requests unchanged)", () => {
    const result = body({ temperature: 0.7 })
    expect("top_k" in result ? result.top_k : undefined).toBeUndefined()
  })

  test("the full protocol-owned sampling set maps through", () => {
    const result = body({
      temperature: 0.6,
      topP: 0.95,
      topK: 20,
      maxTokens: 1024,
      frequencyPenalty: 0.1,
      presencePenalty: 0.2,
      seed: 42,
    })
    expect(result).toMatchObject({
      temperature: 0.6,
      top_p: 0.95,
      top_k: 20,
      max_tokens: 1024,
      frequency_penalty: 0.1,
      presence_penalty: 0.2,
      seed: 42,
    })
  })
})
