// 1M (codehamr A6) — context-window discipline: the deterministic fail-safe packing layer.
//
// THE local-model killer: Ollama-class /v1 servers report no window and on overflow silently
// FRONT-truncate — the agent loses its system prompt and earlier tool results mid-task with no
// error. Compaction (the semantic first line) needs a working summary model call; this layer is
// the zero-cost guarantee underneath it: pack every outgoing request to the server's HONORED
// window so the server never truncates for us.
//
// Pure and unit-testable (config-resolve style); the runner calls `packRequest` from request
// assembly AFTER the compaction check. History stays intact in the DB — a bigger window
// instantly restores evicted turns; no summarization happens here.
//
// The window packed to is the server's HONORED window (`model.limit.context` from config /
// catalog), NOT the model's theoretical max — qwen does 256k only if vLLM `--max-model-len` /
// OLLAMA_CONTEXT_LENGTH says so. When no window is configured we assume a conservative default:
// silently losing the system prompt is strictly worse than evicting old turns early.

import { Message } from "@novaclaw/llm"
import type { LLMRequest, SystemPart, ToolDefinition } from "@novaclaw/llm"
import { Token } from "../../util/token"
import { STEER_PROVENANCE_PREFIX } from "../input"

export * as ContextPack from "./context-pack"

/** Safe default when the model config reports no honored window (the Ollama-class case). */
export const DEFAULT_CONTEXT_SIZE = 32_000
/** Reasoning models need room to answer: reserve max(contextSize/8, this). */
export const MIN_RESPONSE_RESERVE = 8_192
/** Flat per-tool-call token overhead the chars/4 estimate can't see (ids, wire framing). */
export const TOOL_CALL_OVERHEAD = 8
/** chars/4 UNDERcounts code/JSON-heavy history — keep 10% headroom (pack to 90% of available). */
export const BUDGET_KEEP_FRACTION = 0.9
/** ctx_pressure tripwire: reported prompt tokens at ≥95% of the window flags the estimator. */
export const PRESSURE_THRESHOLD = 0.95

const toolCallCount = (message: Message) =>
  message.content.filter((part) => part.type === "tool-call" || part.type === "tool-result").length

/** tokens(msg) ≈ chars/4 (+8 per tool call/result) — tokenizer-free by design. */
export const estimateMessage = (message: Message): number => {
  let text: string
  try {
    text = JSON.stringify(message.content) ?? ""
  } catch {
    text = String(message.content)
  }
  return Token.estimate(text) + toolCallCount(message) * TOOL_CALL_OVERHEAD
}

export const estimateMessages = (messages: ReadonlyArray<Message>): number =>
  messages.reduce((total, message) => total + estimateMessage(message), 0)

const estimateJson = (value: unknown): number => {
  try {
    return Token.estimate(JSON.stringify(value) ?? "")
  } catch {
    return 0
  }
}

/**
 * Budget = contextSize − system − tools − responseReserve − headroom.
 * Never negative — a degenerate window still packs the newest message (always kept).
 */
export const budget = (input: {
  readonly contextSize: number
  readonly system: ReadonlyArray<SystemPart>
  readonly tools: ReadonlyArray<ToolDefinition>
  readonly maxTokens?: number | undefined
}): number => {
  const systemTokens = input.system.reduce((total, part) => total + Token.estimate(part.text), 0)
  const toolTokens = estimateJson(input.tools)
  const reserve = Math.max(Math.floor(input.contextSize / 8), MIN_RESPONSE_RESERVE, input.maxTokens ?? 0)
  const available = input.contextSize - systemTokens - toolTokens - reserve
  return Math.max(0, Math.floor(available * BUDGET_KEEP_FRACTION))
}

const firstTextPart = (message: Message): string | undefined => {
  for (const part of message.content) if (part.type === "text") return part.text
  return undefined
}

/**
 * A REAL user message — not a harness steer (A1 provenance prefix) riding the user role. The
 * anchor pass and the "since last user message" semantics both key off this.
 */
export const isRealUserMessage = (message: Message): boolean =>
  message.role === "user" && !(firstTextPart(message) ?? "").startsWith(STEER_PROVENANCE_PREFIX)

const localToolCallIds = (message: Message): string[] =>
  message.role === "assistant"
    ? message.content.flatMap((part) => (part.type === "tool-call" && part.providerExecuted !== true ? [part.id] : []))
    : []

const toolResultIds = (messages: ReadonlyArray<Message>): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.role !== "tool") continue
    for (const part of message.content) if (part.type === "tool-result") ids.add(part.id)
  }
  return ids
}

/**
 * Wire-legality pass 1 — an assistant whose tool calls weren't all answered (the abort-mid-tool
 * case) 400s strict backends and wedges the session until reset. Remove the unanswered
 * ToolCallParts; drop the message entirely if nothing meaningful remains.
 */
export const dropDanglingToolCalls = (messages: ReadonlyArray<Message>): Message[] => {
  const answered = toolResultIds(messages)
  return messages.flatMap((message) => {
    const dangling = localToolCallIds(message).filter((id) => !answered.has(id))
    if (dangling.length === 0) return [message]
    const remaining = message.content.filter((part) => !(part.type === "tool-call" && dangling.includes(part.id)))
    if (remaining.length === 0) return []
    return [Message.make({ ...message, content: remaining })]
  })
}

/**
 * Wire-legality pass 2 — a tool result whose owning assistant got evicted is an orphan; so is a
 * result with an empty id (an empty tool_call_id 400s the next request). Runs on the KEPT set
 * after eviction.
 */
export const dropOrphanTools = (messages: ReadonlyArray<Message>): Message[] => {
  const owned = new Set(messages.flatMap(localToolCallIds))
  return messages.filter((message) => {
    if (message.role !== "tool") return true
    return message.content.every((part) => part.type !== "tool-result" || (part.id !== "" && owned.has(part.id)))
  })
}

/**
 * Wire-legality pass 5 — a mid-history `system` message 400s some strict backends. Demote to a
 * provenance-prefixed user message. MUST run after the anchor pass, or a demoted note could
 * masquerade as the surviving user message (the prefix keeps `isRealUserMessage` false either way).
 */
export const demoteSystemMessages = (messages: ReadonlyArray<Message>): Message[] =>
  messages.map((message) => {
    if (message.role !== "system") return message
    const text = message.content.map((part) => ("text" in part ? part.text : "")).join("\n")
    return Message.make({ ...message, role: "user", content: [Message.text(STEER_PROVENANCE_PREFIX + text)] })
  })

export interface PackResult {
  readonly messages: Message[]
  /** true when anything was evicted or repaired — the runner rebuilds the request only then. */
  readonly changed: boolean
  readonly dropped: number
  readonly estimatedTokens: number
}

/**
 * Pack whole messages newest-first until the budget, return chronological; the newest message is
 * always kept even if alone over budget. Then repair the kept set: orphan results dropped,
 * newest assistant+results group recovered whole if eviction emptied the window, and the FIRST
 * real user message re-prepended when packing would evict the sole user message — "the original
 * task, the agent's anchor against drift" — deliberately over budget.
 */
export const pack = (messages: ReadonlyArray<Message>, budgetTokens: number): PackResult => {
  const repaired = dropDanglingToolCalls(messages)
  const estimates = repaired.map(estimateMessage)
  const total = estimates.reduce((sum, tokens) => sum + tokens, 0)
  if (total <= budgetTokens) {
    const legal = demoteSystemMessages(dropOrphanTools(repaired))
    const changed = legal.length !== messages.length || legal.some((message, i) => message !== messages[i])
    return { messages: legal, changed, dropped: messages.length - legal.length, estimatedTokens: total }
  }

  // Newest-first, whole messages; newest always kept.
  let used = 0
  let start = repaired.length
  for (let i = repaired.length - 1; i >= 0; i--) {
    const next = used + estimates[i]!
    if (next > budgetTokens && start < repaired.length) break
    used = next
    start = i
  }
  let kept = dropOrphanTools(repaired.slice(start))

  // Recover the newest assistant+results group whole (deliberately over budget) if the orphan
  // pass emptied the window down to nothing usable.
  if (kept.length === 0 || kept.every((message) => message.role === "tool")) {
    let newestAssistant = -1
    for (let i = repaired.length - 1; i >= 0; i--) {
      if (repaired[i]!.role === "assistant") {
        newestAssistant = i
        break
      }
    }
    if (newestAssistant >= 0) kept = dropOrphanTools(repaired.slice(newestAssistant))
  }

  // Original-task anchoring (pass 4): never let packing evict the sole real user message.
  if (!kept.some(isRealUserMessage)) {
    const anchor = repaired.find(isRealUserMessage)
    if (anchor !== undefined) kept = [anchor, ...kept]
  }

  kept = demoteSystemMessages(kept)
  return {
    messages: kept,
    changed: true,
    dropped: messages.length - kept.length,
    estimatedTokens: estimateMessages(kept),
  }
}

/** The runner-facing composition: budget from the request's own system/tools, then pack. */
export const packRequest = (input: {
  readonly request: LLMRequest
  readonly contextSize: number | undefined
}): PackResult & { readonly contextSize: number } => {
  const contextSize =
    input.contextSize !== undefined && input.contextSize > 0 ? input.contextSize : DEFAULT_CONTEXT_SIZE
  const result = pack(
    input.request.messages,
    budget({
      contextSize,
      system: input.request.system,
      tools: input.request.tools,
      maxTokens: input.request.generation?.maxTokens,
    }),
  )
  return { ...result, contextSize }
}

/**
 * A6(7) — the ctx_pressure tripwire: every response, compare the server-REPORTED prompt tokens
 * against the window; at ≥95% the real prompt has outgrown the packer's estimate and the next
 * request risks silent server-side truncation. Instruments the estimator's blind spot instead of
 * trusting it.
 */
export const ctxPressure = (reportedPromptTokens: number, contextSize: number): boolean =>
  contextSize > 0 && reportedPromptTokens >= contextSize * PRESSURE_THRESHOLD
