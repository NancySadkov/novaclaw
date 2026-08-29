export * as PromptEstimate from "./prompt-estimate"

import type { LLMRequest, Usage } from "@novaclaw/llm"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { Hash } from "../../util/hash"
import { Token } from "../../util/token"

type RequestShape = Pick<LLMRequest, "system" | "messages" | "tools">

export interface Scope {
  readonly sessionID: SessionMessage.PromptAnchor["sessionID"]
  readonly contextEpoch: number
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly serverKey: string
  readonly routeID: string
  readonly protocolID: string
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
  readonly deltaTokens: number
  readonly growth: number
  readonly confidence: "whole" | "anchored" | "low"
  readonly fallback: Fallback
  readonly anchorReportedTokens: number
  readonly anchorHeuristicTokens: number
}

const positiveInt = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0

const nonNegativeInt = (value: number | undefined): value is number =>
  value !== undefined && Number.isSafeInteger(value) && value >= 0

/** The one request-level heuristic. Item ranking remains in ContextPack. */
export const whole = (request: RequestShape): number =>
  Token.estimateStructured({ system: request.system, messages: request.messages, tools: request.tools })

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

/** Stable identity for the governing prompt and tool catalogue; never logged or sent off-box. */
export const shapeKey = (request: Pick<RequestShape, "system" | "tools">): string =>
  Hash.sha256(JSON.stringify({ system: request.system, tools: request.tools }))

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
  if (anchor.controllerKey !== scope.controllerKey) return "controller-changed"
  if (anchor.shapeKey !== currentShapeKey) return "shape-changed"
  return "none"
}

const calibrationFactor = (value: number | undefined): number =>
  value !== undefined && Number.isFinite(value) ? Math.min(1.25, Math.max(1, value)) : 1

const inflate = (tokens: number, factor: number): number =>
  Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(tokens * factor))

const full = (heuristicTokens: number, fallback: Fallback, factor: number = 1): Result => ({
  heuristicTokens,
  estimatedTokens: inflate(heuristicTokens, factor),
  correctionTokens: inflate(heuristicTokens, factor) - heuristicTokens,
  deltaTokens: 0,
  growth: 0,
  confidence: "whole",
  fallback,
  anchorReportedTokens: 0,
  anchorHeuristicTokens: 0,
})

/** A durable anchor from one exact settled base/opening provider request. */
export const observe = (input: {
  readonly request: RequestShape
  readonly usage: Usage | undefined
  readonly scope: Scope
}): SessionMessage.PromptAnchor | undefined => {
  const reportedTokens = reportedPromptTokens(input.usage)
  const heuristicTokens = whole(input.request)
  if (!positiveInt(reportedTokens) || !positiveInt(heuristicTokens)) return undefined
  return {
    ...input.scope,
    shapeKey: shapeKey(input.request),
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
}): Result => {
  const heuristicTokens = whole(input.request)
  const factor = calibrationFactor(input.calibrationFactor)
  if (!positiveInt(heuristicTokens)) return full(heuristicTokens, "invalid", factor)
  const currentShapeKey = shapeKey(input.request)
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
    deltaTokens,
    growth,
    confidence: growth > 0.15 ? "low" : "anchored",
    fallback: "none",
    anchorReportedTokens: anchor.reportedTokens,
    anchorHeuristicTokens: anchor.heuristicTokens,
  }
}

export const unsupported = (request: RequestShape): Result => full(whole(request), "unsupported")
