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
  readonly deviceKey: string
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

const mismatch = (anchor: SessionMessage.PromptAnchor, scope: Scope, currentShapeKey: string): Fallback => {
  if (anchor.sessionID !== scope.sessionID) return "session-changed"
  if (anchor.contextEpoch !== scope.contextEpoch) return "epoch-changed"
  if (anchor.providerID !== scope.providerID) return "provider-changed"
  if (anchor.modelID !== scope.modelID || anchor.variant !== scope.variant) return "model-changed"
  if (anchor.deviceKey !== scope.deviceKey) return "server-changed"
  if (anchor.routeID !== scope.routeID) return "route-changed"
  if (anchor.protocolID !== scope.protocolID) return "protocol-changed"
  if (anchor.controllerKey !== scope.controllerKey) return "controller-changed"
  if (anchor.shapeKey !== currentShapeKey) return "shape-changed"
  return "none"
}

const full = (heuristicTokens: number, fallback: Fallback): Result => ({
  heuristicTokens,
  estimatedTokens: heuristicTokens,
  correctionTokens: 0,
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
}): Result => {
  const heuristicTokens = whole(input.request)
  if (!positiveInt(heuristicTokens)) return full(heuristicTokens, "invalid")
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
  if (anchor === undefined) return full(heuristicTokens, fallback)
  if (!positiveInt(anchor.heuristicTokens) || !positiveInt(anchor.reportedTokens))
    return full(heuristicTokens, "invalid")
  const deltaTokens = heuristicTokens - anchor.heuristicTokens
  const estimatedTokens = anchor.reportedTokens + deltaTokens
  if (!positiveInt(estimatedTokens)) return full(heuristicTokens, "invalid")
  const growth = Math.max(0, deltaTokens) / anchor.reportedTokens
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
