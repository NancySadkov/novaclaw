import { describe, expect, test } from "bun:test"
import { LLM, LLMClient, Provider } from "@novaclaw/llm"
import { Route, Protocol } from "@novaclaw/llm/route"
import { Provider as ProviderSubpath } from "@novaclaw/llm/provider"
import {
  CloudflareAIGateway,
  CloudflareWorkersAI,
  OpenAI,
  OpenAICompatible,
  OpenRouter,
  XAI,
} from "@novaclaw/llm/providers"
import { OpenAIChat, OpenAICompatibleChat, OpenAIResponses } from "@novaclaw/llm/protocols"
import * as AnthropicMessages from "@novaclaw/llm/protocols/anthropic-messages"

describe("public exports", () => {
  test("root exposes app-facing runtime APIs", () => {
    expect(LLM.request).toBeFunction()
    expect(LLMClient.Service).toBeFunction()
    expect(LLMClient.layer).toBeDefined()
    expect(Provider.make).toBeFunction()
    expect(ProviderSubpath.make).toBe(Provider.make)
  })

  test("route barrel exposes route-authoring APIs", () => {
    expect(Route.make).toBeFunction()
    expect(Protocol.make).toBeFunction()
  })

  test("provider barrels expose user-facing facades", () => {
    expect(OpenAI.model).toBeFunction()
    expect(OpenAI.provider.model).toBe(OpenAI.model)
    expect(OpenAI.provider.responses).toBe(OpenAI.responses)
    expect(OpenAI.provider.responsesWebSocket).toBe(OpenAI.responsesWebSocket)
    expect(OpenAI.configure({ apiKey: "fixture" }).responses).toBeFunction()
    expect(OpenAICompatible.deepseek.model).toBeFunction()
    expect(CloudflareAIGateway.configure).toBeFunction()
    expect(CloudflareAIGateway.configure({ accountId: "fixture", gatewayApiKey: "fixture" }).model).toBeFunction()
    expect(CloudflareWorkersAI.configure).toBeFunction()
    expect(CloudflareWorkersAI.configure({ accountId: "fixture", apiKey: "fixture" }).model).toBeFunction()
    expect(OpenRouter.model).toBeFunction()
    expect(OpenRouter.provider.model).toBe(OpenRouter.model)
    expect(XAI.model).toBeFunction()
    expect(XAI.provider.model).toBe(XAI.model)
    expect(XAI.provider.responses).toBe(XAI.responses)
    expect(XAI.provider.chat).toBe(XAI.chat)
    expect(XAI.configure({ apiKey: "fixture" }).responses("grok-4.3").route.id).toBe("openai-responses")
    expect(XAI.configure({ apiKey: "fixture" }).chat("grok-4.3").route.id).toBe("openai-compatible-chat")
  })

  test("protocol barrels expose supported low-level routes", () => {
    expect(OpenAIChat.route.id).toBe("openai-chat")
    expect(OpenAICompatibleChat.route.id).toBe("openai-compatible-chat")
    expect(OpenAIResponses.route.id).toBe("openai-responses")
    expect(OpenAIResponses.webSocketRoute.id).toBe("openai-responses-websocket")
    expect(AnthropicMessages.route.id).toBe("anthropic-messages")
  })
})
