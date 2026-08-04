import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { HttpTransport } from "../route/transport"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ReasoningPart,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { isRecord, JsonObject, optionalArray, optionalNull, ProviderShared } from "./shared"
import { OpenAIOptions } from "./utils/openai-options"
import { Lifecycle } from "./utils/lifecycle"
import { ToolSchemaProjection } from "./utils/tool-schema"
import { ToolStream } from "./utils/tool-stream"
import { recoverToolCallsFromText, resolveToolName } from "./utils/tool-recovery"
import { truncatedArgsInput } from "./utils/truncated-args"

const ADAPTER = "openai-chat"
const IMAGE_MIMES = new Set<string>(ProviderShared.IMAGE_MIMES)
export const DEFAULT_BASE_URL = "https://api.openai.com/v1"
export const PATH = "/chat/completions"

// =============================================================================
// Request Body Schema
// =============================================================================
// The body schema is the provider-native JSON body. `fromRequest` below builds
// this shape from the common `LLMRequest`, then `Route.make` validates and
// JSON-encodes it before transport.
const OpenAIChatFunction = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: JsonObject,
})

const OpenAIChatTool = Schema.Struct({
  type: Schema.tag("function"),
  function: OpenAIChatFunction,
})
type OpenAIChatTool = Schema.Schema.Type<typeof OpenAIChatTool>

const OpenAIChatAssistantToolCall = Schema.Struct({
  id: Schema.String,
  type: Schema.tag("function"),
  function: Schema.Struct({
    name: Schema.String,
    arguments: Schema.String,
  }),
})
type OpenAIChatAssistantToolCall = Schema.Schema.Type<typeof OpenAIChatAssistantToolCall>

const OpenAIChatUserContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image_url"),
    image_url: Schema.Struct({ url: Schema.String }),
  }),
])

const OpenAIChatMessage = Schema.Union([
  Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
  Schema.Struct({
    role: Schema.Literal("user"),
    content: Schema.Union([Schema.String, Schema.Array(OpenAIChatUserContent)]),
  }),
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.NullOr(Schema.String),
    tool_calls: optionalArray(OpenAIChatAssistantToolCall),
    reasoning_content: Schema.optional(Schema.String),
  }),
  Schema.Struct({ role: Schema.Literal("tool"), tool_call_id: Schema.String, content: Schema.String }),
]).pipe(Schema.toTaggedUnion("role"))
type OpenAIChatMessage = Schema.Schema.Type<typeof OpenAIChatMessage>

const OpenAIChatToolChoice = Schema.Union([
  Schema.Literals(["auto", "none", "required"]),
  Schema.Struct({
    type: Schema.tag("function"),
    function: Schema.Struct({ name: Schema.String }),
  }),
])

// S5 — constrained decoding, the protocol half.
//
// `response_format` is the one constraint channel that is CROSS-ENGINE on THIS wire — the OpenAI
// standard, which api.openai.com, vLLM (guided decoding), `llama-server` and SGLang all expose on
// their `/chat/completions`. That is why it — and not a grammar field — is what the protocol owns:
// ruling 10 (the Wire Test) says a thing needing new code stays a CLOSED COMPILED SET whose every
// member must be reachable, and `text`/`json_schema` are reachable on all four.
//
// ⚠️ UNVERIFIED HERE, and it is the live smoke's job: per-engine acceptance is read from vendor
// docs, not measured. `todo/sidecar-inference.md` records llama.cpp's constraint surface as the
// SERVER FLAGS `--grammar`/`--json-schema`; that the per-REQUEST `response_format` form is honoured
// by `llama-server` and by the Spark's vLLM has not been observed by anyone on this codebase. An
// engine that ignores it degrades to today's behaviour (see the "asks, and assumes nothing" tests)
// — it never fails a turn — but do not describe this as proven until a real endpoint has echoed it.
//
// ⚠️ Engine-specific constraint knobs (llama.cpp `grammar`, vLLM `guided_regex`/`guided_choice`)
// are the OTHER half of ruling 10 — values that travel an existing wire, so they go to an OPEN
// RUNTIME STORE and need no code at all. They already work: a key in a model's config `options`
// that is not canonical sampling lands in `http.body` (runner `sampling-split.ts`) and is merged
// into the body by the transport, and `grammar` is NOT on that transport's denylist. Do not add a
// `grammar` field here — it would move a per-engine knob into the one place that must stay
// engine-neutral, and it belongs in the runtime profile S3 owns.
//
// ⚠️ `strict` is deliberately NOT sent. OpenAI's strict subset additionally demands
// `additionalProperties: false` plus EVERY property listed in `required`; `strict: true` with a
// schema missing either is a hard 400 on every turn — which is the "worse than no constraint"
// failure this slice exists to prevent. Local engines ignore `strict` and enforce the schema by
// grammar regardless, so omitting it costs nothing on the models this product targets. Add it the
// day someone has measured a real endpoint, not before.
const OpenAIChatResponseFormat = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text") }),
  Schema.Struct({
    type: Schema.Literal("json_schema"),
    json_schema: Schema.Struct({ name: Schema.String, schema: JsonObject }),
  }),
])

export const bodyFields = {
  model: Schema.String,
  messages: Schema.Array(OpenAIChatMessage),
  tools: optionalArray(OpenAIChatTool),
  tool_choice: Schema.optional(OpenAIChatToolChoice),
  // S5: built ONLY from `LLMRequest.responseFormat`, which is absent unless a caller asks for a
  // constraint — so a request that wants none is byte-identical to before and api.openai.com sees
  // no new field. Same config-gated shape as `top_k` below. The key is also on the transport's
  // `PROTOCOL_BODY_OVERLAY_DENYLIST`, where it had been RESERVED but unimplemented since the
  // denylist was written; this is the commit that makes that reservation honest — the protocol now
  // owns the field, so an `http.body` overlay of it is correctly refused as a second source.
  response_format: Schema.optional(OpenAIChatResponseFormat),
  stream: Schema.Literal(true),
  stream_options: Schema.optional(Schema.Struct({ include_usage: Schema.Boolean })),
  store: Schema.optional(Schema.Boolean),
  reasoning_effort: Schema.optional(OpenAIOptions.OpenAIReasoningEffort),
  max_tokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  top_p: Schema.optional(Schema.Number),
  // 1C: not in the official OpenAI API, but every local OpenAI-compatible server that matters
  // here (vLLM, llama.cpp, ollama) accepts it. Encoded only when a config actually sets it,
  // so requests to api.openai.com are unchanged. Without this, `generation.topK` (routed by
  // the V2 sampling-split, and denylisted from the http.body overlay as protocol-owned) was
  // silently dropped — the ONE sampling param that could not reach a local model.
  top_k: Schema.optional(Schema.Number),
  frequency_penalty: Schema.optional(Schema.Number),
  presence_penalty: Schema.optional(Schema.Number),
  seed: Schema.optional(Schema.Number),
  stop: optionalArray(Schema.String),
}
const OpenAIChatBody = Schema.Struct(bodyFields)
export type OpenAIChatBody = Schema.Schema.Type<typeof OpenAIChatBody>

// =============================================================================
// Streaming Event Schema
// =============================================================================
// The event schema is one decoded SSE `data:` payload. `Framing.sse` splits the
// byte stream into strings, then `Protocol.jsonEvent` decodes each string into
// this provider-native event shape.
const OpenAIChatUsage = Schema.Struct({
  prompt_tokens: Schema.optional(Schema.Number),
  completion_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
  prompt_tokens_details: optionalNull(
    Schema.Struct({
      cached_tokens: Schema.optional(Schema.Number),
    }),
  ),
  completion_tokens_details: optionalNull(
    Schema.Struct({
      reasoning_tokens: Schema.optional(Schema.Number),
    }),
  ),
})

const OpenAIChatToolCallDeltaFunction = Schema.Struct({
  name: optionalNull(Schema.String),
  arguments: optionalNull(Schema.String),
})

const OpenAIChatToolCallDelta = Schema.Struct({
  index: Schema.Number,
  id: optionalNull(Schema.String),
  function: optionalNull(OpenAIChatToolCallDeltaFunction),
})
type OpenAIChatToolCallDelta = Schema.Schema.Type<typeof OpenAIChatToolCallDelta>

const OpenAIChatDelta = Schema.Struct({
  content: optionalNull(Schema.String),
  reasoning_content: optionalNull(Schema.String),
  // Some OpenAI-compatible backends (e.g. vLLM serving qwen3) stream the thinking
  // block under `reasoning` rather than `reasoning_content`. Accept both — matching
  // `@ai-sdk/openai-compatible`'s `reasoning_content ?? reasoning` tolerance — so the
  // model's reasoning isn't silently dropped at decode (no reasoning events => no
  // persisted/rendered/foldable thinking).
  reasoning: optionalNull(Schema.String),
  tool_calls: optionalNull(Schema.Array(OpenAIChatToolCallDelta)),
})

const OpenAIChatChoice = Schema.Struct({
  delta: optionalNull(OpenAIChatDelta),
  finish_reason: optionalNull(Schema.String),
})

const OpenAIChatEvent = Schema.Struct({
  choices: Schema.Array(OpenAIChatChoice),
  usage: optionalNull(OpenAIChatUsage),
})
type OpenAIChatEvent = Schema.Schema.Type<typeof OpenAIChatEvent>
type OpenAIChatRequestMessage = LLMRequest["messages"][number]

interface ParserState {
  readonly tools: ToolStream.State<number>
  readonly toolCallEvents: ReadonlyArray<LLMEvent>
  readonly usage?: Usage
  readonly finishReason?: FinishReason
  readonly lifecycle: Lifecycle.State
  // The request's tool names — the whitelist that keeps text-recovery from
  // misreading prose with angle brackets as a call. Empty => recovery is off.
  readonly allowedToolNames: ReadonlyArray<string>
  // Assistant text accumulated across deltas, so that on halt we can recover a
  // tool call a small model dumped into TEXT instead of the structured channel.
  readonly content: string
  // Reasoning accumulated across deltas: when a thinking model derails, the tool call
  // often lands INSIDE the reasoning channel (vLLM routes it to reasoning_content and its
  // tool parser never sees it) while the visible text is only leaked mask-token debris.
  // Scavenged as the LAST resort — see finalToolCallEvents.
  readonly reasoning: string
}

const invalid = ProviderShared.invalidRequest

// =============================================================================
// Request Lowering
// =============================================================================
// Lowering is the only place that knows how common LLM messages map onto the
// OpenAI Chat wire format. Keep provider quirks here instead of leaking native
// fields into `LLMRequest`.
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema): OpenAIChatTool => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: ToolSchemaProjection.openAI(inputSchema),
  },
})

const lowerToolChoice = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("OpenAI Chat", toolChoice, {
    auto: () => "auto" as const,
    none: () => "none" as const,
    required: () => "required" as const,
    tool: (name) => ({ type: "function" as const, function: { name } }),
  })

// The `json_schema.name` OpenAI requires. A CONSTANT, not the schema's own `title`: upstream
// validates this field against a name charset, and a human-authored title ("My Result") would turn
// a constraint into a 400 — the failure mode this slice is written to avoid.
const RESPONSE_FORMAT_NAME = "novaclaw_response"

/**
 * `LLMRequest.responseFormat` -> the OpenAI Chat wire.
 *
 * The caller's JSON Schema travels **verbatim**. It is deliberately NOT run through
 * `ToolSchemaProjection.openAI` (which force-sets `type: "object"` and flattens `anyOf`): that
 * projection exists to work around per-model TOOL-schema quirks, and applying it here would send a
 * constraint the caller did not ask for. A schema the backend rejects should produce the backend's
 * own complaint, which is the true one — ruling 2, *a fault is never described falsely*.
 *
 * ⚠️ **This constrains the assistant's CONTENT, not tool-call arguments.** On the OpenAI Chat wire
 * a tool call is constrained by `function.strict` (OpenAI) or by the server's own tool grammar
 * (llama.cpp `--jinja`, vLLM `tool_choice: "required"`), never by `response_format`. The roadmap's
 * "a malformed tool call becomes unrepresentable" is real but is a DIFFERENT field; see
 * `todo/sidecar-inference.md` S5.
 */
const lowerResponseFormat = Effect.fn("OpenAIChat.lowerResponseFormat")(function* (
  format: NonNullable<LLMRequest["responseFormat"]>,
) {
  if (format.type === "text") return { type: "text" as const }
  if (format.type === "json")
    return {
      type: "json_schema" as const,
      json_schema: { name: RESPONSE_FORMAT_NAME, schema: format.schema },
    }
  // Named rather than silently dropped (ruling 2) — for whatever member arrives, not for one spelling.
  //
  // ⚠️ **This branch is unreachable from the TYPE and live at RUNTIME, deliberately.** The member it
  // used to name by hand, `responseFormat: { type: "tool" }`, was deleted from the closed set on
  // 2026-07-31 for having no producer anywhere in the tree (ruling 10 — see `ResponseFormat`'s own
  // comment in `schema/messages.ts`; the short version is that "call this tool" is `tool_choice`,
  // which this protocol already lowers from `request.toolChoice` and which `LLM.generateObject`
  // already drives). What survives is the guard: the day a third member is added to `ResponseFormat`
  // without a lowering here, a caller's constraint would otherwise be dropped on the floor silently.
  // `schema/response-format-members.test.ts` fails on that same day and names the missing arm.
  const unexpressible = (format as { readonly type: string }).type
  return yield* invalid(
    `OpenAI Chat cannot express responseFormat \`${unexpressible}\` as response_format — force the call with toolChoice instead (LLM.generateObject already does)`,
  )
})

const lowerToolCall = (part: ToolCallPart): OpenAIChatAssistantToolCall => ({
  id: part.id,
  type: "function",
  function: {
    name: part.name,
    arguments: ProviderShared.encodeJson(part.input),
  },
})

const lowerMedia = Effect.fn("OpenAIChat.lowerMedia")(function* (part: MediaPart) {
  const media = yield* ProviderShared.validateMedia("OpenAI Chat", part, IMAGE_MIMES)
  return { type: "image_url" as const, image_url: { url: media.dataUrl } }
})

const openAICompatibleReasoningContent = (native: unknown) => {
  if (!isRecord(native)) return undefined
  // Accept the `reasoning` alias (vLLM/qwen3) in addition to `reasoning_content`.
  if (typeof native.reasoning_content === "string") return native.reasoning_content
  if (typeof native.reasoning === "string") return native.reasoning
  return undefined
}

const lowerUserMessage = Effect.fn("OpenAIChat.lowerUserMessage")(function* (message: OpenAIChatRequestMessage) {
  const content: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (part.type === "text") {
      content.push({ type: "text", text: part.text })
      continue
    }
    if (part.type === "media") {
      content.push(yield* lowerMedia(part))
      continue
    }
    return yield* ProviderShared.unsupportedContent("OpenAI Chat", "user", ["text", "media"])
  }
  if (content.every((part) => part.type === "text"))
    return { role: "user" as const, content: content.map((part) => part.text).join("") }
  return { role: "user" as const, content }
})

const lowerAssistantMessage = Effect.fn("OpenAIChat.lowerAssistantMessage")(function* (
  message: OpenAIChatRequestMessage,
) {
  const content: TextPart[] = []
  const reasoning: ReasoningPart[] = []
  const toolCalls: OpenAIChatAssistantToolCall[] = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "assistant", ["text", "reasoning", "tool-call"])
    if (part.type === "text") {
      content.push(part)
      continue
    }
    if (part.type === "reasoning") {
      reasoning.push(part)
      continue
    }
    if (part.type === "tool-call") {
      toolCalls.push(lowerToolCall(part))
      continue
    }
  }
  // ⭐ OMITTED, not refused. `text` and `tool_calls` are this wire's only renderable assistant
  // channels; an assistant with neither lowers to `{"role":"assistant","content":null}` with no
  // `tool_calls`, and `reasoning_content` is a vLLM/DeepSeek extension, not an OpenAI field —
  // qwen's own chat template STRIPS think blocks (verified live: `@novaclaw/core`
  // session/runner/reasoning-budget.ts), so the turn renders as an EMPTY assistant message in the
  // prompt the model actually sees. A thinking model that reasons and produces nothing else mints
  // this shape on a NORMAL finish (`@novaclaw/core` session/runner/doom-loop.ts
  // `isEmptyAssistantTurn`, whose own comment states the same two-channel rule this guard keys on),
  // and the row is durable, so it is re-sent on every later turn forever.
  //
  // Why omit rather than `unsupportedContent`: `InvalidRequestReason.retryable` is `false`
  // (schema/errors.ts), so a refusal would turn one routine empty turn into a permanently
  // unrunnable session. Ruling 2 agrees — there is no fault to describe: the reasoning is
  // model-authored scratch, the durable transcript still holds it, and the user still sees it.
  // Refusal is right one branch up, for MEDIA, because that is user-authored content this wire
  // cannot carry and silence would lose the user's own data.
  //
  // ⚠️ Why HERE and not in `@novaclaw/core` (ruling 6): the answer is per-wire, not shared.
  // Anthropic lowers the same message to a legal `thinking` block carrying the signature it must
  // echo back, Gemini to `{thought:true}`, Bedrock to `reasoningContent`, and `openai-responses`
  // ALREADY omits it (`lowerReasoning` returns undefined without an itemId) — precedent for this
  // exact drop in this exact layer. A core-side drop would strip all four, and it was rejected for
  // that reason: it turns `session-runner-message.test.ts` red on two round-trip pins that exist to
  // keep an empty-text reasoning part alive as a metadata carrier. `openai-compatible-chat`
  // inherits this fix for free — it reuses `OpenAIChat.protocol` verbatim, and that is the local
  // vLLM/qwen3.6-35b path where this actually bites.
  //
  // The condition keys on the two renderable channels, NOT on "has reasoning": `[reasoning,
  // tool-call]` is the normal thinking-model assistant and must survive untouched. It is also
  // UNCONDITIONAL with respect to reasoning `providerMetadata` — an Anthropic signature or an
  // OpenAI Responses `itemId` never reaches this body (only `part.text` is read below), so on THIS
  // wire the message carries zero information whatever it is carrying for another one. Exempting
  // metadata here is the mistake that leaves the defect reachable, and it is pinned red by "drops
  // an unrenderable assistant whatever its reasoning carries". Note what the guard narrows: past
  // it, `content.length === 0` implies `toolCalls.length > 0`, so `content: null` now ships ONLY
  // alongside `tool_calls` — the one configuration our own recorded cassettes show a live backend
  // accepting.
  //
  // ⚠️ KNOWN RESIDUAL, deliberately not handled here: if this drops the last entry, `fromRequest`
  // emits `messages: []`, which a backend rejects. Measured over the owner's real sessions it
  // happens only for a session with NO user message at all, and only before `lowerMessages`
  // prepends the system turn — which `@novaclaw/core` always supplies, so the production floor is a
  // system-only request, not an empty array. An empty-request guard is a separate decision.
  if (content.length === 0 && toolCalls.length === 0) return []
  return [
    {
      role: "assistant" as const,
      content: content.length === 0 ? null : ProviderShared.joinText(content),
      tool_calls: toolCalls.length === 0 ? undefined : toolCalls,
      reasoning_content:
        reasoning.length > 0
          ? reasoning.map((part) => part.text).join("")
          : openAICompatibleReasoningContent(message.native?.openaiCompatible),
    },
  ]
})

const lowerToolMessages = Effect.fn("OpenAIChat.lowerToolMessages")(function* (message: OpenAIChatRequestMessage) {
  const messages: OpenAIChatMessage[] = []
  const images: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  for (const part of message.content) {
    if (!ProviderShared.supportsContent(part, ["tool-result"]))
      return yield* ProviderShared.unsupportedContent("OpenAI Chat", "tool", ["tool-result"])
    if (part.result.type !== "content") {
      messages.push({ role: "tool", tool_call_id: part.id, content: ProviderShared.toolResultText(part) })
      continue
    }
    const content: ReadonlyArray<ToolContent> = part.result.value
    const text = content.filter((item) => item.type === "text").map((item) => item.text)
    messages.push({ role: "tool", tool_call_id: part.id, content: text.join("\n") })
    const files = content.filter((item) => item.type === "file")
    images.push(
      ...(yield* Effect.forEach(files, (item) =>
        lowerMedia({ type: "media", mediaType: item.mime, data: item.uri, filename: item.name }),
      )),
    )
  }
  return { messages, images }
})

const lowerMessage = Effect.fn("OpenAIChat.lowerMessage")(function* (message: OpenAIChatRequestMessage) {
  if (message.role === "user") return [yield* lowerUserMessage(message)]
  // 0..n, like `lowerToolMessages` — the assistant arm drops unrenderable messages (see there).
  if (message.role === "assistant") return yield* lowerAssistantMessage(message)
  return (yield* lowerToolMessages(message)).messages
})

const lowerMessages = Effect.fn("OpenAIChat.lowerMessages")(function* (request: LLMRequest) {
  const system: OpenAIChatMessage[] =
    request.system.length === 0 ? [] : [{ role: "system", content: ProviderShared.joinText(request.system) }]
  const messages = [...system]
  const pendingImages: Array<Schema.Schema.Type<typeof OpenAIChatUserContent>> = []
  const flushImages = () => {
    if (pendingImages.length === 0) return
    messages.push({ role: "user", content: pendingImages.splice(0) })
  }
  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("OpenAI Chat", message)
      if (pendingImages.length > 0) {
        messages.push({ role: "user", content: [...pendingImages.splice(0), { type: "text", text: part.text }] })
        continue
      }
      const previous = messages.at(-1)
      if (previous?.role === "user" && typeof previous.content === "string")
        messages[messages.length - 1] = { role: "user", content: `${previous.content}\n${part.text}` }
      else if (previous?.role === "user" && Array.isArray(previous.content))
        messages[messages.length - 1] = {
          role: "user",
          content: [...previous.content, { type: "text", text: part.text }],
        }
      else messages.push({ role: "user", content: part.text })
      continue
    }
    if (message.role === "tool") {
      const lowered = yield* lowerToolMessages(message)
      messages.push(...lowered.messages)
      pendingImages.push(...lowered.images)
      continue
    }
    flushImages()
    messages.push(...(yield* lowerMessage(message)))
  }
  flushImages()
  return messages
})

const lowerOptions = Effect.fn("OpenAIChat.lowerOptions")(function* (request: LLMRequest) {
  const store = OpenAIOptions.store(request)
  const reasoningEffort = OpenAIOptions.reasoningEffort(request)
  if (reasoningEffort && !OpenAIOptions.isReasoningEffort(reasoningEffort))
    return yield* invalid(`OpenAI Chat does not support reasoning effort ${reasoningEffort}`)
  return {
    ...(store !== undefined ? { store } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  }
})

const fromRequest = Effect.fn("OpenAIChat.fromRequest")(function* (request: LLMRequest) {
  // `fromRequest` returns the provider body only. Endpoint, auth, framing,
  // validation, and HTTP execution are composed by `Route.make`.
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  return {
    model: request.model.id,
    messages: yield* lowerMessages(request),
    tools:
      request.tools.length === 0
        ? undefined
        : request.tools.map((tool) =>
            lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
          ),
    tool_choice: request.toolChoice ? yield* lowerToolChoice(request.toolChoice) : undefined,
    // Spread, not `key: undefined`: an unrequested constraint leaves the key ABSENT from the body.
    ...(request.responseFormat === undefined
      ? {}
      : { response_format: yield* lowerResponseFormat(request.responseFormat) }),
    stream: true as const,
    stream_options: { include_usage: true },
    max_tokens: generation?.maxTokens,
    temperature: generation?.temperature,
    top_p: generation?.topP,
    top_k: generation?.topK,
    frequency_penalty: generation?.frequencyPenalty,
    presence_penalty: generation?.presencePenalty,
    seed: generation?.seed,
    stop: generation?.stop,
    ...(yield* lowerOptions(request)),
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Streaming parsers are small state machines: every event returns a new state
// plus the common `LLMEvent`s produced by that event. Tool calls are accumulated
// because OpenAI streams JSON arguments across multiple deltas.
const mapFinishReason = (reason: string | null | undefined): FinishReason => {
  if (reason === "stop") return "stop"
  if (reason === "length") return "length"
  if (reason === "content_filter") return "content-filter"
  if (reason === "function_call" || reason === "tool_calls") return "tool-calls"
  return "unknown"
}

// Canonicalize a structured tool-call name against the request's tools (Write -> write,
// a near-typo -> the real name). An unresolved name passes through unchanged — a genuine
// unknown tool is the runner's to surface as a recoverable error, not the decoder's to drop.
const canonicalToolName = (raw: string | null | undefined, allowed: ReadonlyArray<string>): string | undefined => {
  if (!raw) return undefined
  return resolveToolName(raw, allowed) ?? raw
}

// OpenAI Chat reports `prompt_tokens` (inclusive total) with a
// `cached_tokens` subset, and `completion_tokens` (inclusive total) with
// a `reasoning_tokens` subset. We pass the inclusive totals through and
// derive the non-cached breakdown so the `LLM.Usage` contract is
// satisfied on both sides.
const mapUsage = (usage: OpenAIChatEvent["usage"]): Usage | undefined => {
  if (!usage) return undefined
  const cached = usage.prompt_tokens_details?.cached_tokens
  const reasoning = usage.completion_tokens_details?.reasoning_tokens
  const nonCached = ProviderShared.subtractTokens(usage.prompt_tokens, cached)
  return new Usage({
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: reasoning,
    totalTokens: ProviderShared.totalTokens(usage.prompt_tokens, usage.completion_tokens, usage.total_tokens),
    providerMetadata: { openai: usage },
  })
}

const step = (state: ParserState, event: OpenAIChatEvent) =>
  Effect.gen(function* () {
    const events: LLMEvent[] = []
    const usage = mapUsage(event.usage) ?? state.usage
    const choice = event.choices[0]
    const finishReason = choice?.finish_reason ? mapFinishReason(choice.finish_reason) : state.finishReason
    const delta = choice?.delta
    const toolDeltas = delta?.tool_calls ?? []
    let tools = state.tools

    let lifecycle = state.lifecycle

    const reasoningDelta = delta?.reasoning_content ?? delta?.reasoning
    if (reasoningDelta) lifecycle = Lifecycle.reasoningDelta(lifecycle, events, "reasoning-0", reasoningDelta)

    if (delta?.content) {
      lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0")
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", delta.content)
    }

    if (toolDeltas.length) lifecycle = Lifecycle.reasoningEnd(lifecycle, events, "reasoning-0")

    for (const tool of toolDeltas) {
      const result = ToolStream.appendOrStart(
        ADAPTER,
        tools,
        tool.index,
        {
          id: tool.id ?? undefined,
          name: canonicalToolName(tool.function?.name, state.allowedToolNames),
          text: tool.function?.arguments ?? "",
        },
        "OpenAI Chat tool call delta is missing id or name",
      )
      if (ToolStream.isError(result)) return yield* result
      tools = result.tools
      if (result.events.length) lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(...result.events)
    }

    // Finalize accumulated tool inputs eagerly when finish_reason arrives. A JSON parse failure here
    // is almost always the server truncating a large call at its output-token limit (1O/A4): instead
    // of failing the stream (a halt), emit the call with a truncated-args sentinel the settle path
    // lowers into a prescriptive "build the file in chunks" result. The recovered call keeps the loop
    // going and classifies as a failure for the 1N/A2 streak.
    const finished =
      finishReason !== undefined && state.finishReason === undefined && Object.keys(tools).length > 0
        ? yield* ToolStream.finishAllRecoverable(ADAPTER, tools, () =>
            truncatedArgsInput("unexpected end of JSON input"),
          )
        : undefined

    return [
      {
        tools: finished?.tools ?? tools,
        toolCallEvents: finished?.events ?? state.toolCallEvents,
        usage,
        finishReason,
        lifecycle,
        allowedToolNames: state.allowedToolNames,
        content: delta?.content ? state.content + delta.content : state.content,
        reasoning: reasoningDelta ? state.reasoning + reasoningDelta : state.reasoning,
      },
      events,
    ] as const
  })

// Arguments recovered from text are already a valid JSON string; parse defensively
// so a freak value can never throw inside the decoder.
const safeParseArgs = (json: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(json)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

// True when the turn's visible text is nothing but whitespace and leaked special-token
// debris (`<|mask_start|>`, stray `<think>` tags) — the model produced NO answer.
const debrisOnly = (content: string) =>
  content
    .replace(/<\|[^|>]*\|>/g, "")
    .replace(/<\/?think>/g, "")
    .trim().length === 0

// The tool-call events to finalize with. Prefer the structured calls; only when the
// model emitted NONE do we try to recover one it dumped into assistant text. The
// recovery core is whitelist-gated on `allowedToolNames`, so ordinary prose / code
// with angle brackets is never misread as a call. LAST resort: when the visible text
// is pure debris (no answer at all — the doom-loop signature), scavenge the REASONING
// channel, where a derailed thinking model often left the complete call.
const finalToolCallEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  if (state.toolCallEvents.length > 0) return state.toolCallEvents
  const fromText = recoverToolCallsFromText(state.content, state.allowedToolNames)
  const calls =
    fromText.length > 0
      ? fromText
      : debrisOnly(state.content)
        ? recoverToolCallsFromText(state.reasoning, state.allowedToolNames)
        : []
  return calls.flatMap((call, index) => {
    const id = `call_recovered_${index}`
    return [
      LLMEvent.toolInputStart({ id, name: call.name }),
      LLMEvent.toolInputEnd({ id, name: call.name }),
      LLMEvent.toolCall({ id, name: call.name, input: safeParseArgs(call.arguments) }),
    ]
  })
}

const finishEvents = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  const toolCallEvents = finalToolCallEvents(state)
  const hasToolCalls = toolCallEvents.length > 0
  // A model that emits a tool call but reports finish="stop", or dumps the call into
  // text, must still continue the loop instead of halting — synthesize "tool-calls".
  const reason = state.finishReason === "stop" && hasToolCalls ? "tool-calls" : state.finishReason
  const lifecycle = hasToolCalls ? Lifecycle.stepStart(state.lifecycle, events) : state.lifecycle
  events.push(...toolCallEvents)
  if (reason) Lifecycle.finish(lifecycle, events, { reason, usage: state.usage })
  return events
}

// =============================================================================
// Protocol And OpenAI Route
// =============================================================================
/**
 * The OpenAI Chat protocol — request body construction, body schema, and the
 * streaming-event state machine. Reused by every route that speaks OpenAI Chat
 * over HTTP+SSE: native OpenAI, DeepSeek, TogetherAI, Cerebras, Baseten,
 * Fireworks, DeepInfra, and (once added) Azure OpenAI Chat.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: OpenAIChatBody,
    from: fromRequest,
  },
  stream: {
    event: Protocol.jsonEvent(OpenAIChatEvent),
    initial: (request) => ({
      tools: ToolStream.empty<number>(),
      toolCallEvents: [],
      lifecycle: Lifecycle.initial(),
      // Discovered tools are described by append-only tool results, never reinserted into the wire
      // `tools` array. They still belong to the decoder's recovery whitelist: qwen occasionally
      // prints a valid call as text, and losing that call solely because its schema arrived through
      // the transcript would make discovery transport-dependent. Structured unknown names already
      // pass through above; this closes the text-dumped sibling without changing `fromRequest`.
      allowedToolNames: [...new Set([...request.tools.map((tool) => tool.name), ...(request.callableTools ?? [])])],
      content: "",
      reasoning: "",
    }),
    step,
    onHalt: finishEvents,
  },
})

export const httpTransport = HttpTransport.sseJson.with<OpenAIChatBody>()

export const route = Route.make({
  id: ADAPTER,
  provider: "openai",
  protocol,
  endpoint: Endpoint.path(PATH, { baseURL: DEFAULT_BASE_URL }),
  auth: Auth.none,
  transport: httpTransport,
})

export * as OpenAIChat from "./openai-chat"
