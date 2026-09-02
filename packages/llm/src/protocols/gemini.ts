import { Effect, Schema } from "effect"
import { Route } from "../route/client"
import { Auth } from "../route/auth"
import { Endpoint } from "../route/endpoint"
import { Framing } from "../route/framing"
import { Protocol } from "../route/protocol"
import {
  LLMEvent,
  Usage,
  type FinishReason,
  type JsonSchema,
  type LLMRequest,
  type MediaPart,
  type ProviderMetadata,
  type TextPart,
  type ToolCallPart,
  type ToolDefinition,
  type ToolContent,
} from "../schema"
import { JsonObject, optionalArray, ProviderShared } from "./shared"
import { GeminiToolSchema } from "./utils/gemini-tool-schema"
import { Halt } from "./utils/halt"
import { Lifecycle } from "./utils/lifecycle"
import { PromptedTools } from "./utils/prompted-tools"
import { ToolSchemaProjection } from "./utils/tool-schema"

const ADAPTER = "gemini"
const MEDIA_MIMES = new Set<string>(ProviderShared.MEDIA_MIMES)
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

// =============================================================================
// Request Body Schema
// =============================================================================
const GeminiTextPart = Schema.Struct({
  text: Schema.String,
  thought: Schema.optional(Schema.Boolean),
  thoughtSignature: Schema.optional(Schema.String),
})

const GeminiInlineDataPart = Schema.Struct({
  inlineData: Schema.Struct({
    mimeType: Schema.String,
    data: Schema.String,
  }),
})

const GeminiFunctionCallPart = Schema.Struct({
  functionCall: Schema.Struct({
    name: Schema.String,
    args: Schema.Unknown,
  }),
  thoughtSignature: Schema.optional(Schema.String),
})

const GeminiFunctionResponsePart = Schema.Struct({
  functionResponse: Schema.Struct({
    name: Schema.String,
    response: Schema.Unknown,
  }),
})

const GeminiContentPart = Schema.Union([
  GeminiTextPart,
  GeminiInlineDataPart,
  GeminiFunctionCallPart,
  GeminiFunctionResponsePart,
])

const GeminiContent = Schema.Struct({
  role: Schema.Literals(["user", "model"]),
  parts: Schema.Array(GeminiContentPart),
})
type GeminiContent = Schema.Schema.Type<typeof GeminiContent>

const GeminiSystemInstruction = Schema.Struct({
  parts: Schema.Array(Schema.Struct({ text: Schema.String })),
})

const GeminiFunctionDeclaration = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  parameters: Schema.optional(JsonObject),
})

const GeminiTool = Schema.Struct({
  functionDeclarations: Schema.Array(GeminiFunctionDeclaration),
})

const GeminiToolConfig = Schema.Struct({
  functionCallingConfig: Schema.Struct({
    mode: Schema.Literals(["AUTO", "NONE", "ANY"]),
    allowedFunctionNames: optionalArray(Schema.String),
  }),
})

const GeminiThinkingConfig = Schema.Struct({
  thinkingBudget: Schema.optional(Schema.Number),
  includeThoughts: Schema.optional(Schema.Boolean),
})

const GeminiGenerationConfig = Schema.Struct({
  maxOutputTokens: Schema.optional(Schema.Number),
  temperature: Schema.optional(Schema.Number),
  topP: Schema.optional(Schema.Number),
  topK: Schema.optional(Schema.Number),
  stopSequences: optionalArray(Schema.String),
  thinkingConfig: Schema.optional(GeminiThinkingConfig),
})

const GeminiBodyFields = {
  contents: Schema.Array(GeminiContent),
  systemInstruction: Schema.optional(GeminiSystemInstruction),
  tools: optionalArray(GeminiTool),
  toolConfig: Schema.optional(GeminiToolConfig),
  generationConfig: Schema.optional(GeminiGenerationConfig),
}
const GeminiBody = Schema.Struct(GeminiBodyFields)
export type GeminiBody = Schema.Schema.Type<typeof GeminiBody>

const GeminiUsage = Schema.Struct({
  cachedContentTokenCount: Schema.optional(Schema.Number),
  thoughtsTokenCount: Schema.optional(Schema.Number),
  promptTokenCount: Schema.optional(Schema.Number),
  candidatesTokenCount: Schema.optional(Schema.Number),
  totalTokenCount: Schema.optional(Schema.Number),
})
type GeminiUsage = Schema.Schema.Type<typeof GeminiUsage>

const GeminiCandidate = Schema.Struct({
  content: Schema.optional(GeminiContent),
  finishReason: Schema.optional(Schema.String),
})

const GeminiEvent = Schema.Struct({
  candidates: optionalArray(GeminiCandidate),
  usageMetadata: Schema.optional(GeminiUsage),
})
type GeminiEvent = Schema.Schema.Type<typeof GeminiEvent>

interface ParserState {
  readonly finishReason?: string
  readonly hasToolCalls: boolean
  readonly nextToolCallId: number
  readonly usage?: Usage
  readonly lifecycle: Lifecycle.State
  readonly reasoningSignature?: string
  /**
   * Which reasoning SEGMENT of this turn is open, counted from 0.
   *
   * ⚠️ A `{thought:true}` part carries no id of its own, so the block id has to be synthesized — and
   * a constant is the wrong synthesis. A model that thinks, answers, and thinks again closes the
   * block and re-opens it, and with a constant id the second open re-uses an id the consumer has
   * already seen ended: whichever store keys on it keeps one of the two thought blocks and silently
   * loses the other. The counter makes the id say which segment it is, the way the two protocols
   * with real ids on the wire already do (`reasoning-<index>`, `<item_id>:<summary_index>`).
   */
  readonly reasoningSegment: number
}

// =============================================================================
// Tool Schema Conversion
// =============================================================================
// Tool-schema conversion has two distinct concerns:
//
// 1. Sanitize — fix common authoring mistakes Gemini rejects: integer/number
//    enums (must be strings), `required` entries that don't match a property,
//    untyped arrays (`items` must be present), and `properties`/`required`
//    keys on non-object scalars. Mirrors NovaClaw's historical Gemini rules.
//
// 2. Project — lossy mapping from JSON Schema to Gemini's schema dialect:
//    drop empty objects, derive `nullable: true` from `type: [..., "null"]`,
//    coerce `const` to `[const]` enum, recurse properties/items, propagate
//    only an allowlisted set of keys (description, required, format, type,
//    properties, items, allOf, anyOf, oneOf, minLength). Anything outside the
//    allowlist (e.g. `additionalProperties`, `$ref`) is silently dropped.
//
// Sanitize runs first, then project. The implementation lives in
// `utils/gemini-tool-schema` so this protocol keeps the same shape as the other
// provider protocols.

// =============================================================================
// Request Lowering
// =============================================================================
const lowerTool = (tool: ToolDefinition, inputSchema: JsonSchema) => ({
  name: tool.name,
  description: tool.description,
  parameters: GeminiToolSchema.convert(inputSchema),
})

const lowerToolConfig = (toolChoice: NonNullable<LLMRequest["toolChoice"]>) =>
  ProviderShared.matchToolChoice("Gemini", toolChoice, {
    auto: () => ({ functionCallingConfig: { mode: "AUTO" as const } }),
    none: () => ({ functionCallingConfig: { mode: "NONE" as const } }),
    required: () => ({ functionCallingConfig: { mode: "ANY" as const } }),
    tool: (name) => ({ functionCallingConfig: { mode: "ANY" as const, allowedFunctionNames: [name] } }),
  })

const lowerUserPart = Effect.fn("Gemini.lowerUserPart")(function* (part: TextPart | MediaPart) {
  if (part.type === "text") return { text: part.text }
  const media = yield* ProviderShared.validateMedia("Gemini", part, MEDIA_MIMES)
  return { inlineData: { mimeType: media.mime, data: media.base64 } }
})

const googleMetadata = (metadata: Record<string, unknown>): ProviderMetadata => ({ google: metadata })

const thoughtSignature = (providerMetadata: ProviderMetadata | undefined) => {
  const google = providerMetadata?.google
  return ProviderShared.isRecord(google) && typeof google.thoughtSignature === "string"
    ? google.thoughtSignature
    : undefined
}

const lowerToolCall = (part: ToolCallPart) => ({
  functionCall: { name: part.name, args: part.input },
  thoughtSignature: thoughtSignature(part.providerMetadata),
})

const lowerMessages = Effect.fn("Gemini.lowerMessages")(function* (request: LLMRequest) {
  const contents: GeminiContent[] = []

  for (const message of request.messages) {
    if (message.role === "system") {
      const part = yield* ProviderShared.wrappedSystemUpdate("Gemini", message)
      const previous = contents.at(-1)
      if (previous?.role === "user")
        contents[contents.length - 1] = { role: "user", parts: [...previous.parts, { text: part.text }] }
      else contents.push({ role: "user", parts: [{ text: part.text }] })
      continue
    }

    if (message.role === "user") {
      const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "media"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "user", ["text", "media"])
        parts.push(yield* lowerUserPart(part))
      }
      contents.push({ role: "user", parts })
      continue
    }

    if (message.role === "assistant") {
      const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
      for (const part of message.content) {
        if (!ProviderShared.supportsContent(part, ["text", "reasoning", "tool-call"]))
          return yield* ProviderShared.unsupportedContent("Gemini", "assistant", ["text", "reasoning", "tool-call"])
        if (part.type === "text") {
          parts.push({ text: part.text })
          continue
        }
        if (part.type === "reasoning") {
          parts.push({ text: part.text, thought: true, thoughtSignature: thoughtSignature(part.providerMetadata) })
          continue
        }
        if (part.type === "tool-call") {
          parts.push(lowerToolCall(part))
          continue
        }
      }
      contents.push({ role: "model", parts })
      continue
    }

    const parts: Array<Schema.Schema.Type<typeof GeminiContentPart>> = []
    for (const part of message.content) {
      if (!ProviderShared.supportsContent(part, ["tool-result"]))
        return yield* ProviderShared.unsupportedContent("Gemini", "tool", ["tool-result"])
      if (part.result.type !== "content") {
        parts.push({
          functionResponse: {
            name: part.name,
            response: {
              name: part.name,
              content: ProviderShared.toolResultText(part),
            },
          },
        })
        continue
      }
      const content: ReadonlyArray<ToolContent> = part.result.value
      const text = content.filter((item) => item.type === "text").map((item) => item.text)
      parts.push({
        functionResponse: {
          name: part.name,
          response: {
            name: part.name,
            content: text.join("\n"),
          },
        },
      })
      for (const item of content) {
        if (item.type === "text") continue
        const media = yield* ProviderShared.validateToolFile("Gemini", item, MEDIA_MIMES)
        parts.push({ inlineData: { mimeType: media.mime, data: media.base64 } })
      }
    }
    contents.push({ role: "user", parts })
  }

  return contents
})

const geminiOptions = (request: LLMRequest) => request.providerOptions?.gemini

const thinkingConfig = (request: LLMRequest) => {
  const value = geminiOptions(request)?.thinkingConfig
  if (!ProviderShared.isRecord(value)) return undefined
  const result = {
    thinkingBudget: typeof value.thinkingBudget === "number" ? value.thinkingBudget : undefined,
    includeThoughts: typeof value.includeThoughts === "boolean" ? value.includeThoughts : undefined,
  }
  return Object.values(result).some((item) => item !== undefined) ? result : undefined
}

const fromRequest = Effect.fn("Gemini.fromRequest")(function* (request: LLMRequest) {
  // 🔴 One branch, both halves — see `prompted-tools.ts`. On the prompted channel no
  // `functionDeclarations` go out and the tools are described in `systemInstruction` instead.
  const prompted = PromptedTools.isPrompted(request)
  const toolsEnabled = !prompted && request.tools.length > 0 && request.toolChoice?.type !== "none"
  const generation = request.generation
  const toolSchemaCompatibility = request.model.compatibility?.toolSchema
  const generationConfig = {
    maxOutputTokens: generation?.maxTokens,
    temperature: generation?.temperature,
    topP: generation?.topP,
    topK: generation?.topK,
    stopSequences: generation?.stop,
    thinkingConfig: thinkingConfig(request),
  }

  const toolsSection = prompted ? PromptedTools.promptedToolsSection(request.tools) : undefined
  // One instruction, not two parts: this wire takes a single `systemInstruction`, and splitting it
  // would leave the tools in a part some templates drop.
  const systemText = [ProviderShared.joinText(request.system), toolsSection].filter(Boolean).join("\n\n")
  const systemInstruction = systemText.length === 0 ? undefined : { parts: [{ text: systemText }] }

  return {
    contents: yield* lowerMessages(request),
    systemInstruction: systemInstruction,
    tools: toolsEnabled
      ? [
          {
            functionDeclarations: request.tools.map((tool) =>
              lowerTool(tool, ToolSchemaProjection.modelCompatibility(tool.inputSchema, toolSchemaCompatibility)),
            ),
          },
        ]
      : undefined,
    toolConfig: toolsEnabled && request.toolChoice ? yield* lowerToolConfig(request.toolChoice) : undefined,
    generationConfig: Object.values(generationConfig).some((value) => value !== undefined)
      ? generationConfig
      : undefined,
  }
})

// =============================================================================
// Stream Parsing
// =============================================================================
// Gemini reports `promptTokenCount` (inclusive total) with a
// `cachedContentTokenCount` subset. `candidatesTokenCount` is *exclusive*
// of `thoughtsTokenCount` — visible-only, not a total — so we sum the two
// to produce the inclusive `outputTokens` the rest of the contract expects.
const mapUsage = (usage: GeminiUsage | undefined) => {
  if (!usage) return undefined
  const cached = usage.cachedContentTokenCount
  const nonCached = ProviderShared.subtractTokens(usage.promptTokenCount, cached)
  // `candidatesTokenCount` is visible-only; sum with thoughts to produce the
  // inclusive `outputTokens` the contract expects. Only compute the total
  // when the visible component is reported — otherwise we'd fabricate an
  // inclusive number from a partial breakdown.
  const outputTokens =
    usage.candidatesTokenCount !== undefined ? usage.candidatesTokenCount + (usage.thoughtsTokenCount ?? 0) : undefined
  return new Usage({
    inputTokens: usage.promptTokenCount,
    outputTokens,
    nonCachedInputTokens: nonCached,
    cacheReadInputTokens: cached,
    reasoningTokens: usage.thoughtsTokenCount,
    totalTokens: ProviderShared.totalTokens(usage.promptTokenCount, outputTokens, usage.totalTokenCount),
    providerMetadata: { google: usage },
  })
}

const mapFinishReason = (finishReason: string | undefined, hasToolCalls: boolean): FinishReason => {
  if (finishReason === "STOP") return hasToolCalls ? "tool-calls" : "stop"
  if (finishReason === "MAX_TOKENS") return "length"
  if (
    finishReason === "IMAGE_SAFETY" ||
    finishReason === "RECITATION" ||
    finishReason === "SAFETY" ||
    finishReason === "BLOCKLIST" ||
    finishReason === "PROHIBITED_CONTENT" ||
    finishReason === "SPII"
  )
    return "content-filter"
  if (finishReason === "MALFORMED_FUNCTION_CALL") return "error"
  return "unknown"
}

/**
 * The flush that runs when the framed stream ends — for ANY reason, including one the wire never
 * explained.
 *
 * 🔴 Until 2026-09-02 this was gated on `state.finishReason || state.usage`, so a stream cut before
 * its final chunk emitted NOTHING: no `step-finish`, no `finish`, and every open reasoning/text
 * block left unclosed. This wire delivers each `functionCall` complete inside one part, so unlike
 * the two OpenAI wires nothing was DROPPED — but the turn still never closed, and a successful
 * stream that closed no turn reads to every layer above as a turn that had nothing to say. The
 * shared reasoning is in `utils/halt.ts`; only the two Gemini-specific parts are here.
 */
const finish = (state: ParserState): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  // The thought signature belongs on the END of the reasoning block, and only this wire has one.
  const lifecycle = state.reasoningSignature
    ? Lifecycle.reasoningEnd(
        state.lifecycle,
        events,
        `reasoning-${state.reasoningSegment}`,
        googleMetadata({ thoughtSignature: state.reasoningSignature }),
      )
    : state.lifecycle
  return [
    ...events,
    ...Halt.haltEvents({
      lifecycle,
      // Calls are emitted complete during `step`, so there is no accumulator to flush — but the turn
      // still delivered them, and the close must say "tool-calls" rather than "nothing happened".
      hasToolCalls: state.hasToolCalls,
      finishReason:
        state.finishReason === undefined ? undefined : mapFinishReason(state.finishReason, state.hasToolCalls),
      usage: state.usage,
      // ⚠️ This wire can end with an accounting-only tail — a `usageMetadata` chunk carrying no
      // candidate at all. `generate` folds the stream and REQUIRES a terminal event to answer with,
      // so a usage-only tail must still close, or the usage the server did report is lost behind
      // "Provider stream ended without a terminal finish event".
      close: state.usage !== undefined,
    }),
  ]
}

const step = (state: ParserState, event: GeminiEvent) => {
  const nextState = {
    ...state,
    usage: event.usageMetadata ? (mapUsage(event.usageMetadata) ?? state.usage) : state.usage,
  }
  const candidate = event.candidates?.[0]
  if (!candidate?.content)
    return Effect.succeed([
      { ...nextState, finishReason: candidate?.finishReason ?? nextState.finishReason },
      [],
    ] as const)

  const events: LLMEvent[] = []
  let hasToolCalls = nextState.hasToolCalls
  let lifecycle = nextState.lifecycle
  let nextToolCallId = nextState.nextToolCallId
  let reasoningSignature = nextState.reasoningSignature
  let reasoningSegment = nextState.reasoningSegment
  // Close the open reasoning segment and move the id on, so a LATER thought part opens a new block
  // instead of re-opening one the consumer already saw end. Conditional on the block actually having
  // been open: `Lifecycle.reasoningEnd` is a no-op for an id it does not hold, and an unconditional
  // bump would burn ids on every text part of a non-thinking turn.
  const endReasoning = () => {
    const id = `reasoning-${reasoningSegment}`
    if (!lifecycle.reasoning.has(id)) return
    lifecycle = Lifecycle.reasoningEnd(
      lifecycle,
      events,
      id,
      reasoningSignature ? googleMetadata({ thoughtSignature: reasoningSignature }) : undefined,
    )
    reasoningSegment += 1
  }

  for (const part of candidate.content.parts) {
    if ("thoughtSignature" in part && part.thoughtSignature && "thought" in part && part.thought)
      reasoningSignature = part.thoughtSignature
    if ("text" in part && part.text.length > 0) {
      if (part.thought) {
        lifecycle = Lifecycle.reasoningDelta(
          lifecycle,
          events,
          `reasoning-${reasoningSegment}`,
          part.text,
          part.thoughtSignature ? googleMetadata({ thoughtSignature: part.thoughtSignature }) : undefined,
        )
        continue
      }
      endReasoning()
      lifecycle = Lifecycle.textDelta(lifecycle, events, "text-0", part.text)
      continue
    }

    if ("functionCall" in part) {
      const input = part.functionCall.args
      const id = `tool_${nextToolCallId++}`
      endReasoning()
      lifecycle = Lifecycle.stepStart(lifecycle, events)
      events.push(
        LLMEvent.toolCall({
          id,
          name: part.functionCall.name,
          input,
          providerMetadata: part.thoughtSignature
            ? googleMetadata({ thoughtSignature: part.thoughtSignature })
            : undefined,
        }),
      )
      hasToolCalls = true
    }
  }

  return Effect.succeed([
    {
      ...nextState,
      hasToolCalls,
      lifecycle,
      nextToolCallId,
      reasoningSignature,
      reasoningSegment,
      finishReason: candidate.finishReason ?? nextState.finishReason,
    },
    events,
  ] as const)
}

// =============================================================================
// Protocol And Gemini Route
// =============================================================================
/**
 * The Gemini protocol — request body construction, body schema, and the
 * streaming-event state machine. Used by Google AI Studio Gemini and (once
 * registered) Vertex Gemini.
 */
export const protocol = Protocol.make({
  id: ADAPTER,
  body: {
    schema: GeminiBody,
    from: fromRequest,
    // Gemini spells the turn array `contents`; the system prompt is the separate
    // `systemInstruction`, so an empty `contents` is empty regardless of it.
    conversation: { name: "contents", read: (body) => body.contents },
  },
  stream: {
    event: Protocol.jsonEvent(GeminiEvent),
    initial: () => ({ hasToolCalls: false, nextToolCallId: 0, lifecycle: Lifecycle.initial(), reasoningSegment: 0 }),
    step,
    onHalt: finish,
  },
})

export const route = Route.make({
  id: ADAPTER,
  provider: "google",
  protocol,
  // Gemini's path embeds the model id and pins SSE framing at the URL level.
  endpoint: Endpoint.path(({ request }) => `/models/${request.model.id}:streamGenerateContent?alt=sse`, {
    baseURL: DEFAULT_BASE_URL,
  }),
  auth: Auth.none,
  framing: Framing.sse,
})

export * as Gemini from "./gemini"
