export * as ToolOutputSummary from "./tool-output-summary"

import { ToolOutput, type FinishReason, type ToolResultValue } from "@novaclaw/llm"
import { Effect } from "effect"
import type { ToolOutputStore } from "../../tool-output-store"
import { SessionOrigin } from "../origin"

/** A short semantic receipt is enough to route the next action without occupying another tool result. */
export const MAX_SUMMARY_TOKENS = 1_024
/**
 * The mechanical byte cap is deliberately no larger than the token cap. A strange byte-level
 * tokenizer can charge one token per byte, so a chars-per-token assumption here would recreate the
 * overflow this path exists to recover from.
 */
export const MAX_SUMMARY_BYTES = MAX_SUMMARY_TOKENS
/** Fixed prompt/chat-template headroom, charged conservatively as one UTF-8 byte per token. */
export const PROMPT_RESERVE_TOKENS = 1_024
/** Below this source share, recursive summarization would become thousands of nearly empty calls. */
export const MIN_SOURCE_CHUNK_BYTES = 1_024
/** Eight reduction rounds are ample at the 1/8 per-segment cap and still a hard finite ceiling. */
export const MAX_REDUCTION_ROUNDS = 8
/** Prevent a near-boundary artifact on a tiny-context model from expanding into thousands of calls. */
export const MAX_COMPLETION_CALLS = 64

export interface Source {
  /** Complete output kept only on this in-process handoff; never publish it into session history. */
  readonly output: ToolOutput
  readonly artifacts: ReadonlyArray<ToolOutputStore.OutputArtifact>
}

export interface Completion {
  readonly text: string
  readonly finish?: FinishReason
}

export interface CompletionInput {
  readonly prompt: string
  readonly maxTokens: number
}

export interface Input<E, R> {
  readonly source: Source
  /** Already-bounded output from ToolOutputStore; media and structured UI data are retained. */
  readonly boundedOutput: ToolOutput
  readonly contextTokens: number
  readonly complete: (input: CompletionInput) => Effect.Effect<Completion, E, R>
}

export interface Replacement {
  readonly result: ToolResultValue
  readonly output: ToolOutput
}

const stringify = (value: unknown): string => {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

/** Same textual source ToolOutputStore writes to disk, without re-reading the retained artifact. */
export const sourceText = (output: ToolOutput): string => {
  if (output.content.length === 0) return stringify(output.structured)
  return output.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("")
}

/** Split without cutting a UTF-16 surrogate or exceeding the UTF-8 byte allowance. */
export const splitUtf8 = (text: string, maxBytes: number): string[] => {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) return []
  const limit = Math.floor(maxBytes)
  if (Buffer.byteLength(text, "utf-8") <= limit) return [text]
  const chunks: string[] = []
  let start = 0
  let index = 0
  let used = 0
  for (const scalar of text) {
    const bytes = Buffer.byteLength(scalar, "utf-8")
    if (used > 0 && used + bytes > limit) {
      chunks.push(text.slice(start, index))
      start = index
      used = 0
    }
    // A Unicode scalar is at most four UTF-8 bytes. `limit >= 1` can therefore be smaller than one
    // scalar; keep the scalar whole even then rather than corrupting it. Production calls use the
    // 1 KiB floor below, so only the pure helper's pathological test can take this branch.
    used += bytes
    index += scalar.length
  }
  if (start < text.length) chunks.push(text.slice(start))
  return chunks
}

const fitUtf8Tail = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text
  const marker = "[summary mechanically bounded]\n[oldest text removed]\n"
  const allowance = Math.max(1, maxBytes - Buffer.byteLength(marker, "utf-8"))
  const scalars = Array.from(text)
  let start = scalars.length
  let used = 0
  while (start > 0) {
    const bytes = Buffer.byteLength(scalars[start - 1]!, "utf-8")
    if (used > 0 && used + bytes > allowance) break
    used += bytes
    start--
  }
  return marker + scalars.slice(start).join("")
}

const segmentPrompt = (input: {
  readonly text: string
  readonly index: number
  readonly total: number
  readonly maxBytes: number
  readonly reducing: boolean
}) => `<tool-output>
${SessionOrigin.externalContentFrame("tool output being summarized")}${input.text}
</tool-output>

Summarize this ${input.reducing ? "set of partial tool-output summaries" : "tool-output segment"} faithfully.
Return only the semantic summary, with no preamble. Preserve concrete outcomes, errors, paths, identifiers,
numbers, and next-action-relevant details. Do not invent missing context. Use at most ${input.maxBytes} UTF-8 bytes.
This is segment ${input.index} of ${input.total}.`

const finalPrompt = (text: string, maxBytes: number) => `<tool-output>
${SessionOrigin.externalContentFrame("tool output being summarized")}${text}
</tool-output>

Produce one faithful bounded semantic summary of this tool output.
Return only the summary, with no preamble. Preserve concrete outcomes, errors, paths, identifiers, numbers,
and next-action-relevant details. Do not claim to have seen anything absent from the input.
Use at most ${maxBytes} UTF-8 bytes.`

const trimPrompt = (text: string, maxBytes: number) => `<oversized-summary>
${SessionOrigin.externalContentFrame("an oversized semantic summary being shortened")}${text}
</oversized-summary>

Shorten this semantic tool-output summary without losing its newest outcomes or next-action details.
Return only the shorter summary, with no preamble. Preserve concrete errors, paths, identifiers, and numbers.
Use at most ${maxBytes} UTF-8 bytes. Prefer removing older background before newer results.`

const notice = (artifacts: ReadonlyArray<ToolOutputStore.OutputArtifact>, summary: string) => {
  const routes = artifacts.map((artifact) => artifact.path).join(", ")
  return (
    `[novaclaw: this tool result was semantically summarized to fit the context. ` +
    `The complete original remains available at ${routes}.]\n\n` +
    SessionOrigin.externalContentFrame("a semantic summary derived from tool output") +
    summary
  )
}

/**
 * Map/reduce an eligible retained output under the selected model's own context limit.
 *
 * Every prompt is bounded before construction: UTF-8 bytes are charged as tokens (the conservative
 * direction even for byte-level tokenizers), with an explicit output reserve and fixed envelope
 * reserve. An oversized completion gets one model trim attempt while that request itself fits the
 * real route window; only a failed or still-oversized retry is mechanically tail-bounded. Each
 * intermediate is ultimately capped to at most one eighth of its source segment, so even a provider
 * that ignores max_tokens cannot make the reduction grow. The 4 MiB store ceiling, call ceiling, and
 * round ceiling make the call graph finite.
 *
 * `undefined` is fail-open: the caller keeps ToolOutputStore's ordinary bounded preview.
 */
export const summarize = <E, R>(input: Input<E, R>): Effect.Effect<Replacement | undefined, E, R> =>
  Effect.gen(function* () {
    const artifacts = input.source.artifacts.filter((artifact) => artifact.semanticSummary === "eligible")
    if (artifacts.length === 0) return undefined
    const outputTokens = Math.min(MAX_SUMMARY_TOKENS, Math.max(128, Math.floor(input.contextTokens / 8)))
    const outputBytes = Math.min(MAX_SUMMARY_BYTES, outputTokens)
    const sourceBudgetBytes = Math.floor(input.contextTokens - outputTokens - PROMPT_RESERVE_TOKENS)
    if (sourceBudgetBytes < MIN_SOURCE_CHUNK_BYTES) return undefined
    let current = sourceText(input.source.output)
    if (current.trim().length === 0) return undefined
    let completionCalls = 0
    const complete = (request: CompletionInput) => {
      if (completionCalls >= MAX_COMPLETION_CALLS) return undefined
      completionCalls++
      return input.complete(request)
    }
    const fitCompletion = (text: string, maxBytes: number, maxTokens: number): Effect.Effect<string, never, R> =>
      Effect.gen(function* () {
        const original = text.trim()
        if (Buffer.byteLength(original, "utf-8") <= maxBytes) return original

        const prompt = trimPrompt(original, maxBytes)
        // Bytes-as-tokens is intentionally conservative for unusual tokenizers. Keep the same fixed
        // chat-template/envelope reserve as the first reduction request: a retry that cannot fit is
        // not attempted merely to learn the provider's context-overflow error.
        if (Buffer.byteLength(prompt, "utf-8") + maxTokens + PROMPT_RESERVE_TOKENS <= input.contextTokens) {
          const retry = complete({ prompt, maxTokens })
          if (retry) {
            const shortened = yield* retry.pipe(
              Effect.map((completion) => completion.text.trim()),
              Effect.catch(() => Effect.succeed(undefined)),
            )
            if (shortened && Buffer.byteLength(shortened, "utf-8") <= maxBytes) return shortened
            if (shortened) return fitUtf8Tail(shortened, maxBytes)
          }
        }

        return fitUtf8Tail(original, maxBytes)
      })

    let reducing = false
    for (let round = 0; round < MAX_REDUCTION_ROUNDS; round++) {
      const chunks = splitUtf8(current, sourceBudgetBytes)
      if (chunks.length === 1) {
        const completion = complete({
          prompt: finalPrompt(chunks[0]!, outputBytes),
          maxTokens: outputTokens,
        })
        if (!completion) return undefined
        const completed = yield* completion
        const summary = yield* fitCompletion(completed.text, outputBytes, outputTokens)
        if (summary.length === 0) return undefined
        const text = notice(artifacts, summary)
        const media = input.boundedOutput.content.filter((item) => item.type === "file")
        const output = {
          structured: input.boundedOutput.structured,
          content: [{ type: "text" as const, text }, ...media],
        } satisfies ToolOutput
        return { output, result: ToolOutput.toResultValue(output) }
      }

      const partialBytes = Math.max(128, Math.min(512, Math.floor(sourceBudgetBytes / 8)))
      const partials: string[] = []
      for (let index = 0; index < chunks.length; index++) {
        const completion = complete({
          prompt: segmentPrompt({
            text: chunks[index]!,
            index: index + 1,
            total: chunks.length,
            maxBytes: partialBytes,
            reducing,
          }),
          maxTokens: partialBytes,
        })
        if (!completion) return undefined
        const completed = yield* completion
        const partial = yield* fitCompletion(completed.text, partialBytes, partialBytes)
        if (partial.length === 0) return undefined
        partials.push(`Segment ${index + 1}/${chunks.length}:\n${partial}`)
      }
      const next = partials.join("\n\n")
      // The one-eighth cap should make this strict already; keep the invariant mechanical against
      // labels and a hostile completion so the loop can never circle at the same size.
      current =
        Buffer.byteLength(next, "utf-8") < Buffer.byteLength(current, "utf-8")
          ? next
          : fitUtf8Tail(next, Math.max(MIN_SOURCE_CHUNK_BYTES, Math.floor(Buffer.byteLength(current, "utf-8") / 2)))
      reducing = true
    }
    return undefined
  })
