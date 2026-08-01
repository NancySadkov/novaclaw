import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { request as makeRequest } from "../llm"
import { GenerationOptions, LLMRequest, Message, Model, ToolDefinition } from "../schema"
import { OpenAIChat } from "./openai-chat"

// `fromRequest` reads model/messages/tools/generation — a minimal cast drives the real
// body construction without a live model (same pattern as the recovery test).
const request = (generation: GenerationOptions.Input) =>
  makeRequest({
    model: Model.make({ id: "qwen3.6-35b", provider: "dgx-spark", route: OpenAIChat.route }),
    generation,
  })

const body = (generation: GenerationOptions.Input) =>
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

describe("openai-chat — append-only tool discovery", () => {
  test("keeps the serialized prefix and tools byte-identical after a schema is disclosed in a tool result", () => {
    const resident = new ToolDefinition({
      name: "tool_search",
      description: "Find a tool",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    })
    const dispatcher = new ToolDefinition({
      name: "tool_call",
      description: "Call a discovered tool",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" }, input: { type: "object" } },
        required: ["name", "input"],
      },
    })
    const prefix = [Message.user("File a bug in my repository.")]
    const before = LLMRequest.update(request({}), { messages: prefix, tools: [resident, dispatcher] })
    const after = LLMRequest.update(request({}), {
      messages: [
        ...prefix,
        Message.assistant({ type: "tool-call", id: "call_search", name: "tool_search", input: { query: "file bug" } }),
        Message.tool({
          id: "call_search",
          name: "tool_search",
          result: {
            kind: "tool-discovery",
            tools: [{ name: "github_create_issue", input_schema: { type: "object" } }],
          },
        }),
      ],
      tools: [resident, dispatcher],
      callableTools: ["github_create_issue"],
    })

    const beforeBody = Effect.runSync(OpenAIChat.protocol.body.from(before))
    const afterBody = Effect.runSync(OpenAIChat.protocol.body.from(after))
    const beforeMessages = beforeBody.messages
    const afterMessages = afterBody.messages

    expect(JSON.stringify(afterBody.tools)).toBe(JSON.stringify(beforeBody.tools))
    expect(JSON.stringify(afterMessages.slice(0, beforeMessages.length))).toBe(JSON.stringify(beforeMessages))
    expect(JSON.stringify(afterBody)).not.toContain("callableTools")
    expect(JSON.stringify(afterBody)).not.toContain("callable_tools")
    expect(OpenAIChat.protocol.stream.initial(after).allowedToolNames).toEqual([
      "tool_search",
      "tool_call",
      "github_create_issue",
    ])
  })
})
