import * as AnthropicMessages from "../../src/protocols/anthropic-messages"
import * as Gemini from "../../src/protocols/gemini"
import * as OpenAIChat from "../../src/protocols/openai-chat"
import * as OpenAICompatibleChat from "../../src/protocols/openai-compatible-chat"
import * as OpenAIResponses from "../../src/protocols/openai-responses"
import { Auth } from "../../src/route"
import { describeRecordedGoldenScenarios } from "../recorded-golden"

const openAIAuth = Auth.bearer(process.env.OPENAI_API_KEY ?? "fixture")
const openAIChat = OpenAIChat.route.with({ auth: openAIAuth }).model({ id: "gpt-4o-mini" })
const openAIResponses = OpenAIResponses.route
  .with({
    auth: openAIAuth,
    providerOptions: {
      openai: {
        store: false,
        reasoningEffort: "medium",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
        textVerbosity: "low",
      },
    },
  })
  .model({ id: "gpt-5.5" })

const anthropicRoute = AnthropicMessages.route.with({
  auth: Auth.header("x-api-key", process.env.ANTHROPIC_API_KEY ?? "fixture"),
})
const anthropicHaiku = anthropicRoute.model({ id: "claude-haiku-4-5-20251001" })
const anthropicOpus = anthropicRoute.model({ id: "claude-opus-4-7" })
const gemini = Gemini.route
  .with({ auth: Auth.header("x-goog-api-key", process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "fixture") })
  .model({ id: "gemini-2.5-flash" })

const compatible = (provider: string, baseURL: string, apiKey: string, id: string) =>
  OpenAICompatibleChat.route.with({ provider, endpoint: { baseURL }, auth: Auth.bearer(apiKey) }).model({ id })

const responses = (provider: string, baseURL: string, apiKey: string, id: string) =>
  OpenAIResponses.route.with({ provider, endpoint: { baseURL }, auth: Auth.bearer(apiKey) }).model({ id })

const xaiBasic = responses("xai", "https://api.x.ai/v1", process.env.XAI_API_KEY ?? "fixture", "grok-3-mini")
const xaiFlagship = responses("xai", "https://api.x.ai/v1", process.env.XAI_API_KEY ?? "fixture", "grok-4.3")
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "fixture-account"
const gatewayId = process.env.CLOUDFLARE_GATEWAY_ID?.trim() || "default"
const cloudflareGatewayRoute = OpenAICompatibleChat.route.with({
  id: "cloudflare-ai-gateway",
  provider: "cloudflare-ai-gateway",
  endpoint: {
    baseURL: `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/compat`,
  },
  auth: Auth.bearerHeader("cf-aig-authorization", process.env.CLOUDFLARE_API_TOKEN ?? "fixture"),
})
const cloudflareWorkersRoute = OpenAICompatibleChat.route.with({
  id: "cloudflare-workers-ai",
  provider: "cloudflare-workers-ai",
  endpoint: { baseURL: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1` },
  auth: Auth.bearer(process.env.CLOUDFLARE_API_KEY ?? "fixture"),
})
const cloudflareAIGatewayWorkers = cloudflareGatewayRoute.model({ id: "workers-ai/@cf/meta/llama-3.1-8b-instruct" })
const cloudflareAIGatewayWorkersTools = cloudflareGatewayRoute.model({ id: "workers-ai/@cf/openai/gpt-oss-20b" })
const cloudflareWorkersAI = cloudflareWorkersRoute.model({ id: "@cf/meta/llama-3.1-8b-instruct" })
const cloudflareWorkersAITools = cloudflareWorkersRoute.model({ id: "@cf/openai/gpt-oss-20b" })
const deepseek = compatible(
  "deepseek",
  "https://api.deepseek.com/v1",
  process.env.DEEPSEEK_API_KEY ?? "fixture",
  "deepseek-chat",
)
const together = compatible(
  "togetherai",
  "https://api.together.xyz/v1",
  process.env.TOGETHER_AI_API_KEY ?? "fixture",
  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
)
const groq = compatible(
  "groq",
  "https://api.groq.com/openai/v1",
  process.env.GROQ_API_KEY ?? "fixture",
  "llama-3.3-70b-versatile",
)
const openrouter = compatible(
  "openrouter",
  "https://openrouter.ai/api/v1",
  process.env.OPENROUTER_API_KEY ?? "fixture",
  "openai/gpt-4o-mini",
)
const openrouterGpt55 = compatible(
  "openrouter",
  "https://openrouter.ai/api/v1",
  process.env.OPENROUTER_API_KEY ?? "fixture",
  "openai/gpt-5.5",
)
const openrouterOpus = compatible(
  "openrouter",
  "https://openrouter.ai/api/v1",
  process.env.OPENROUTER_API_KEY ?? "fixture",
  "anthropic/claude-opus-4.7",
)

const redactCloudflareURL = (url: string) =>
  url
    .replace(/\/client\/v4\/accounts\/[^/]+\/ai\/v1\//, "/client/v4/accounts/{account}/ai/v1/")
    .replace(/\/v1\/[^/]+\/[^/]+\/compat\//, "/v1/{account}/{gateway}/compat/")

const cloudflareOptions = {
  redact: { url: redactCloudflareURL },
}

describeRecordedGoldenScenarios([
  {
    name: "OpenAI Chat gpt-4o-mini",
    prefix: "openai-chat",
    model: openAIChat,
    requires: ["OPENAI_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop", { id: "image-tool-result", maxTokens: 40 }],
  },
  {
    name: "OpenAI Responses gpt-5.5",
    prefix: "openai-responses",
    model: openAIResponses,
    requires: ["OPENAI_API_KEY"],
    tags: ["flagship"],
    scenarios: [
      { id: "text", temperature: false },
      { id: "reasoning", temperature: false },
      { id: "reasoning-continuation", temperature: false },
      { id: "tool-call", temperature: false },
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "Anthropic Haiku 4.5",
    prefix: "anthropic-messages",
    model: anthropicHaiku,
    requires: ["ANTHROPIC_API_KEY"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Anthropic Opus 4.7",
    prefix: "anthropic-messages",
    model: anthropicOpus,
    requires: ["ANTHROPIC_API_KEY"],
    tags: ["flagship"],
    options: { redact: { allowRequestHeaders: ["anthropic-version"] } },
    scenarios: [
      { id: "tool-loop", temperature: false },
      { id: "image-tool-result", temperature: false, maxTokens: 40 },
    ],
  },
  {
    name: "Gemini 2.5 Flash",
    prefix: "gemini",
    model: gemini,
    requires: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    scenarios: [
      { id: "text", maxTokens: 80 },
      "tool-call",
      { id: "image", maxTokens: 160 },
      { id: "image-tool-result", maxTokens: 40 },
    ],
  },
  {
    name: "xAI Grok 3 Mini",
    prefix: "xai",
    model: xaiBasic,
    requires: ["XAI_API_KEY"],
    scenarios: ["text", "tool-call"],
  },
  {
    name: "xAI Grok 4.3",
    prefix: "xai",
    model: xaiFlagship,
    requires: ["XAI_API_KEY"],
    tags: ["flagship"],
    scenarios: [{ id: "tool-loop", timeout: 30_000 }],
  },
  {
    name: "Cloudflare AI Gateway Workers AI Llama 3.1 8B",
    prefix: "cloudflare-ai-gateway",
    model: cloudflareAIGatewayWorkers,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    options: cloudflareOptions,
    scenarios: ["text"],
  },
  {
    name: "Cloudflare AI Gateway Workers AI GPT OSS 20B Tools",
    prefix: "cloudflare-ai-gateway",
    model: cloudflareAIGatewayWorkersTools,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
    options: cloudflareOptions,
    scenarios: [{ id: "tool-call", maxTokens: 120 }],
  },
  {
    name: "Cloudflare Workers AI Llama 3.1 8B",
    prefix: "cloudflare-workers-ai",
    model: cloudflareWorkersAI,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    options: cloudflareOptions,
    scenarios: ["text"],
  },
  {
    name: "Cloudflare Workers AI GPT OSS 20B Tools",
    prefix: "cloudflare-workers-ai",
    model: cloudflareWorkersAITools,
    requires: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_KEY"],
    options: cloudflareOptions,
    scenarios: [{ id: "tool-call", maxTokens: 120 }],
  },
  {
    name: "DeepSeek Chat",
    prefix: "openai-compatible-chat",
    model: deepseek,
    requires: ["DEEPSEEK_API_KEY"],
    scenarios: ["text"],
  },
  {
    name: "TogetherAI Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: together,
    requires: ["TOGETHER_AI_API_KEY"],
    scenarios: ["text", "tool-call"],
  },
  {
    name: "Groq Llama 3.3 70B",
    prefix: "openai-compatible-chat",
    model: groq,
    requires: ["GROQ_API_KEY"],
    scenarios: ["text", "tool-call", { id: "tool-loop", timeout: 30_000 }],
  },
  {
    name: "OpenRouter gpt-4o-mini",
    prefix: "openai-compatible-chat",
    model: openrouter,
    requires: ["OPENROUTER_API_KEY"],
    scenarios: ["text", "tool-call", "tool-loop"],
  },
  {
    name: "OpenRouter gpt-5.5",
    prefix: "openai-compatible-chat",
    model: openrouterGpt55,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
  {
    name: "OpenRouter Claude Opus 4.7",
    prefix: "openai-compatible-chat",
    model: openrouterOpus,
    requires: ["OPENROUTER_API_KEY"],
    tags: ["flagship"],
    scenarios: ["tool-loop"],
  },
])
