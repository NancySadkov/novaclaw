export * as PromptEstimate from "./prompt-estimate"

import { mergeHttpOptions, type LLMRequest, type Usage } from "@novaclaw/llm"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { Hash } from "../../util/hash"
import { Token } from "../../util/token"
import { PromptCalibration } from "./prompt-calibration"

type RequestShape = Pick<LLMRequest, "model" | "system" | "messages" | "tools" | "toolChannel" | "http">

export interface Scope {
  readonly sessionID: SessionMessage.PromptAnchor["sessionID"]
  readonly contextEpoch: number
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly serverKey: string
  readonly routeID: string
  readonly protocolID: string
  readonly servedBy?: string
  readonly controllerKey: string
}

export type Fallback =
  | "none"
  | "unavailable"
  | "session-changed"
  | "epoch-changed"
  | "provider-changed"
  | "model-changed"
  | "server-changed"
  | "route-changed"
  | "protocol-changed"
  | "serving-process-changed"
  | "controller-changed"
  | "shape-changed"
  | "invalid"
  | "unsupported"

export interface Result {
  /** Whole-request heuristic before applying provider feedback. */
  readonly heuristicTokens: number
  /** Final value consumed by compaction and the packer's overall capacity boundary. */
  readonly estimatedTokens: number
  /** `estimatedTokens - heuristicTokens`; apply once at an overall request boundary. */
  readonly correctionTokens: number
  /** Estimation uncertainty only. Output capacity is reserved separately by `capacity`. */
  readonly marginTokens: number
  readonly deltaTokens: number
  readonly growth: number
  readonly confidence: "whole" | "anchored" | "low"
  readonly fallback: Fallback
  readonly anchorReportedTokens: number
  readonly anchorHeuristicTokens: number
}

export const MIN_RESPONSE_RESERVE = 8_192
/** Codex-style automatic compaction boundary: retain ten percent of the resolved model window. */
export const AUTO_COMPACT_PERCENT = 90

export interface Capacity {
  readonly contextTokens: number
  readonly responseReserveTokens: number
  /** Exact-route cache observation. Informational only: cache policy must never discard semantics. */
  readonly prefixCacheRetentionTokens?: number
  readonly promptCeilingTokens: number
}

const positiveInt = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0

const nonNegativeInt = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0

const tokenCount = (value: number | undefined): number => {
  if (value === Number.POSITIVE_INFINITY) return Number.MAX_SAFE_INTEGER
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
}

/**
 * One prompt-capacity algebra shared by semantic compaction and deterministic packing.
 *
 * The response reserve is intentionally independent of estimation uncertainty. A caller may raise
 * the minimum (the compaction setting does); it cannot erase the base 10% or 8,192-token reserve.
 * A route's prefix-cache retention is deliberately not a capacity boundary: it describes what is
 * cheap to replay, not what the model can understand. Treating it as capacity made a 262k model
 * forget history around 110k and repeatedly rebuild the very prefix the hint was meant to save.
 */
export const capacity = (input: {
  readonly contextTokens: number
  readonly outputTokens?: number
  readonly minimumResponseReserveTokens?: number
  readonly prefixCacheRetentionTokens?: number
}): Capacity => {
  const contextTokens = tokenCount(input.contextTokens)
  const responseReserveTokens = Math.max(
    Math.ceil((contextTokens * (100 - AUTO_COMPACT_PERCENT)) / 100),
    MIN_RESPONSE_RESERVE,
    tokenCount(input.outputTokens),
    tokenCount(input.minimumResponseReserveTokens),
  )
  const prefixCacheRetentionTokens = positiveInt(input.prefixCacheRetentionTokens)
    ? input.prefixCacheRetentionTokens
    : undefined
  return {
    contextTokens,
    responseReserveTokens,
    ...(prefixCacheRetentionTokens === undefined ? {} : { prefixCacheRetentionTokens }),
    promptCeilingTokens: Math.max(0, contextTokens - responseReserveTokens),
  }
}

export const withMargin = (estimate: Pick<Result, "estimatedTokens" | "marginTokens">): number => {
  const total = tokenCount(estimate.estimatedTokens) + tokenCount(estimate.marginTokens)
  return Math.min(Number.MAX_SAFE_INTEGER, total)
}

/** The one request-level heuristic. Item ranking remains in ContextPack. */
export const whole = (request: RequestShape, imagePatchPixels?: number): number =>
  Token.estimateStructured(
    { system: request.system, messages: request.messages, tools: request.tools },
    imagePatchPixels,
  )

/**
 * Read the normalized inclusive prompt count exactly once.
 *
 * A complete breakdown is accepted only as a fallback for older/custom adapters. When both forms
 * are present, a contradictory complete breakdown rejects the observation rather than silently
 * anchoring the next turn to provider corruption. Partial breakdowns do not override a valid
 * inclusive total.
 */
export const reportedPromptTokens = (usage: Usage | undefined): number | undefined => {
  if (usage === undefined) return undefined
  const parts = [usage.nonCachedInputTokens, usage.cacheReadInputTokens, usage.cacheWriteInputTokens]
  const complete = parts.every(nonNegativeInt)
  const sum = complete ? parts.reduce<number>((total, value) => total + value!, 0) : undefined
  if (positiveInt(usage.inputTokens)) {
    if (sum !== undefined && sum !== usage.inputTokens) return undefined
    return usage.inputTokens
  }
  return positiveInt(sum) ? sum : undefined
}

/**
 * Body fields that change how a server renders or tokenizes the prompt.
 *
 * 🔴 **AN ALLOWLIST, NOT THE WHOLE REQUEST BODY.** `http.body` is an open provider-extension
 * surface and can carry credentials (`apiKey`) as well as sampling, scheduling, and output-only
 * controls. Hashing the record wholesale would persist a secret-derived value and invalidate the
 * anchor for `temperature` or `top_p`, neither of which changes the prompt prefix. These are the
 * request fields supported by local OpenAI-compatible servers that actually alter chat-template or
 * tokenizer input. Add a field here only when its wire semantics change prompt bytes/tokenization.
 */
const TEMPLATE_BODY_FIELDS = [
  "chat_template",
  "chat_template_kwargs",
  "chat_template_content_format",
  "continue_final_message",
  "add_generation_prompt",
  "documents",
  "mm_processor_kwargs",
  "truncate_prompt_tokens",
] as const

/** JSON's semantic value with every object key in stable order. */
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : canonicalJson(item)))
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter((entry) => entry[1] !== undefined)
        // Code-unit order is host/locale independent; an identity cannot depend on ICU settings.
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalJson(item)]),
    )
  if (typeof value === "number") return Number.isFinite(value) ? (value === 0 ? 0 : value) : null
  return value
}

/**
 * Template identity after applying the same route < model < request HTTP precedence as LLM prepare.
 * Only the allowlisted body fields survive; headers, query credentials, and unrelated extras do not.
 */
const templateOptions = (
  request: Pick<RequestShape, "model" | "tools" | "toolChannel" | "http">,
): Readonly<Record<string, unknown>> => {
  const body = mergeHttpOptions(request.model.route.defaults.http, request.model.defaults?.http, request.http)?.body
  const fields = Object.fromEntries(
    TEMPLATE_BODY_FIELDS.flatMap((field) => {
      const value = body?.[field]
      return value === undefined ? [] : [[field, canonicalJson(value)] as const]
    }),
  )
  return {
    // Prompted tools are rendered into the prompt; native tools remain a provider-side catalogue.
    // With no tools, the two channels render identically, so normalize the inert switch to native.
    toolChannel:
      request.tools.length === 0
        ? "native"
        : (request.toolChannel ?? request.model.compatibility?.toolChannel ?? "native"),
    body: fields,
  }
}

/** Stable identity for the governing prompt, tool catalogue, template options, and image grid. */
export const shapeKey = (
  request: Pick<RequestShape, "model" | "system" | "tools" | "toolChannel" | "http">,
  imagePatchPixels?: number,
): string => {
  const resolvedImagePatchPixels =
    imagePatchPixels !== undefined && Number.isSafeInteger(imagePatchPixels) && imagePatchPixels > 0
      ? imagePatchPixels
      : Token.DEFAULT_IMAGE_PATCH_PIXELS
  return Hash.sha256(
    JSON.stringify({
      system: request.system,
      tools: request.tools,
      templateOptions: templateOptions(request),
      imagePatchPixels: resolvedImagePatchPixels,
    }),
  )
}

/**
 * Stable identity of the server route that tokenized this prompt.
 *
 * A Device is physical scheduling capacity and may deliberately group several endpoint processes.
 * Calibration and prompt anchors belong to the endpoint that applied the chat template, so retain
 * the full base URL (including its path) and normalize only trailing slashes. Hosted/test seams that
 * expose no URL fall back to the scheduler identity rather than losing anchoring altogether.
 */
export const serverKey = (baseURL: string | undefined, fallback: string): string => {
  const normalized = baseURL?.replace(/\/+$/, "")
  return normalized === undefined || normalized === "" ? fallback : normalized
}

const mismatch = (anchor: SessionMessage.PromptAnchor, scope: Scope, currentShapeKey: string): Fallback => {
  if (anchor.sessionID !== scope.sessionID) return "session-changed"
  if (anchor.contextEpoch !== scope.contextEpoch) return "epoch-changed"
  if (anchor.providerID !== scope.providerID) return "provider-changed"
  if (anchor.modelID !== scope.modelID || anchor.variant !== scope.variant) return "model-changed"
  if (anchor.serverKey !== scope.serverKey) return "server-changed"
  if (anchor.routeID !== scope.routeID) return "route-changed"
  if (anchor.protocolID !== scope.protocolID) return "protocol-changed"
  if (anchor.servedBy !== scope.servedBy) return "serving-process-changed"
  if (anchor.controllerKey !== scope.controllerKey) return "controller-changed"
  if (anchor.shapeKey !== currentShapeKey) return "shape-changed"
  return "none"
}

const calibrationFactor = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? Math.min(1.25, Math.max(1, value)) : 1

const inflate = (tokens: number, factor: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(tokens * factor))

const full = (
  heuristicTokens: number,
  fallback: Fallback,
  factor: number = 1,
): Result => {
  const estimatedTokens = inflate(heuristicTokens, factor)
  return {
    heuristicTokens,
    estimatedTokens,
    correctionTokens: estimatedTokens - heuristicTokens,
    // Anchored residuals describe anchored predictions only. A whole-request fallback has no
    // comparable residual series, so it receives the conservative fixed floor.
    marginTokens: PromptCalibration.marginTokens(estimatedTokens),
    deltaTokens: 0,
    growth: 0,
    confidence: "whole",
    fallback,
    anchorReportedTokens: 0,
    anchorHeuristicTokens: 0,
  }
}

/** A durable anchor from one exact settled base/opening provider request. */
export const observe = (input: {
  readonly request: RequestShape
  readonly usage: Usage | undefined
  readonly scope: Scope
  readonly imagePatchPixels?: number
}): SessionMessage.PromptAnchor | undefined => {
  const reportedTokens = reportedPromptTokens(input.usage)
  const heuristicTokens = whole(input.request, input.imagePatchPixels)
  if (!positiveInt(reportedTokens) || !positiveInt(heuristicTokens)) return undefined
  return {
    ...input.scope,
    shapeKey: shapeKey(input.request, input.imagePatchPixels),
    heuristicTokens,
    reportedTokens,
  }
}

/**
 * Correct the current whole-request heuristic from the newest compatible durable observation.
 *
 * Scanning past an assistant with absent usage is intentional: absence is not zero, and a valid
 * earlier anchor still describes the same provider/template. A compaction overlay is a hard stop;
 * context-epoch filtering happens before this function receives the transcript.
 */
export const resolve = (input: {
  readonly request: RequestShape
  readonly messages: readonly SessionMessage.Message[]
  readonly scope: Scope
  /** Median provider/heuristic ratio for this exact route; one-sided and capped defensively. */
  readonly calibrationFactor?: number
  /** Recent `reported / anchored-estimate` residual ratios for this exact route and serving process. */
  readonly anchoredResidualRatios?: readonly number[]
  /** The same resolved image grid used to create durable anchor heuristics for this route. */
  readonly imagePatchPixels?: number
}): Result => {
  const heuristicTokens = whole(input.request, input.imagePatchPixels)
  const factor = calibrationFactor(input.calibrationFactor)
  const residuals = input.anchoredResidualRatios ?? []
  if (!positiveInt(heuristicTokens)) return full(heuristicTokens, "invalid", factor)
  const currentShapeKey = shapeKey(input.request, input.imagePatchPixels)
  let fallback: Fallback = "unavailable"
  let anchor: SessionMessage.PromptAnchor | undefined
  for (let index = input.messages.length - 1; index >= 0; index--) {
    const message = input.messages[index]!
    if (message.type === "compaction") break
    if (message.type !== "assistant" || message.context?.promptAnchor === undefined) continue
    const candidate = message.context.promptAnchor
    const reason = mismatch(candidate, input.scope, currentShapeKey)
    if (reason === "none") {
      anchor = candidate
      break
    }
    if (fallback === "unavailable") fallback = reason
  }
  if (anchor === undefined) return full(heuristicTokens, fallback, factor)
  if (!positiveInt(anchor.heuristicTokens) || !positiveInt(anchor.reportedTokens))
    return full(heuristicTokens, "invalid", factor)
  const deltaTokens = heuristicTokens - anchor.heuristicTokens
  // The durable anchor is exact for its settled prefix. Calibrate only NEW positive growth; applying
  // the whole-prompt factor again would double-charge the provider-reported base. A shrinking
  // request keeps its signed delta because one-sided calibration may inflate, never manufacture a
  // larger shrink than the heuristic observed.
  const calibratedDelta = deltaTokens > 0 ? inflate(deltaTokens, factor) : deltaTokens
  const estimatedTokens = anchor.reportedTokens + calibratedDelta
  if (!positiveInt(estimatedTokens)) return full(heuristicTokens, "invalid", factor)
  const growth = Math.max(0, calibratedDelta) / anchor.reportedTokens
  return {
    heuristicTokens,
    estimatedTokens,
    correctionTokens: estimatedTokens - heuristicTokens,
    marginTokens: PromptCalibration.marginTokens(estimatedTokens, residuals),
    deltaTokens,
    growth,
    confidence: growth > 0.15 ? "low" : "anchored",
    fallback: "none",
    anchorReportedTokens: anchor.reportedTokens,
    anchorHeuristicTokens: anchor.heuristicTokens,
  }
}

export const unsupported = (request: RequestShape, imagePatchPixels?: number): Result =>
  full(whole(request, imagePatchPixels), "unsupported")
