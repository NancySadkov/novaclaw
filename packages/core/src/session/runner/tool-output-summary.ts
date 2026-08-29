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

const fitUtf8 = (text: string, maxBytes: number): string => {
  if (Buffer.byteLength(text, "utf-8") <= maxBytes) return text
  const marker = "\n[summary mechanically bounded]"
  const allowance = Math.max(1, maxBytes - Buffer.byteLength(marker, "utf-8"))
  return (splitUtf8(text, allowance)[0] ?? "") + marker
}

const segmentPrompt = (input: {
  readonly text: string
  readonly index: number
  readonly total: number
  readonly maxBytes: number
  readonly reducing: boolean
}) => `Summarize this ${input.reducing ? "set of partial tool-output summaries" : "tool-output segment"} faithfully.
Return only the semantic summary, with no preamble. Preserve concrete outcomes, errors, paths, identifiers,
numbers, and next-action-relevant details. Do not invent missing context. Use at most ${input.maxBytes} UTF-8 bytes.
This is segment ${input.index} of ${input.total}.

<tool-output>
${SessionOrigin.externalContentFrame("tool output being summarized")}${input.text}
</tool-output>`

const finalPrompt = (
  text: string,
  maxBytes: number,
) => `Produce one faithful bounded semantic summary of this tool output.
Return only the summary, with no preamble. Preserve concrete outcomes, errors, paths, identifiers, numbers,
and next-action-relevant details. Do not claim to have seen anything absent from the input.
Use at most ${maxBytes} UTF-8 bytes.

<tool-output>
${SessionOrigin.externalContentFrame("tool output being summarized")}${text}
</tool-output>`

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
 * reserve. Each intermediate completion is mechanically capped to at most one eighth of its source
 * segment, so even a provider that ignores max_tokens cannot make the reduction grow. The 4 MiB
 * store ceiling and the round ceiling make the call graph finite.
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
        const summary = fitUtf8(completed.text.trim(), outputBytes)
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
        const partial = fitUtf8(completed.text.trim(), partialBytes)
        if (partial.length === 0) return undefined
        partials.push(`Segment ${index + 1}/${chunks.length}:\n${partial}`)
      }
      const next = partials.join("\n\n")
      // The one-eighth cap should make this strict already; keep the invariant mechanical against
      // labels and a hostile completion so the loop can never circle at the same size.
      current =
        Buffer.byteLength(next, "utf-8") < Buffer.byteLength(current, "utf-8")
          ? next
          : fitUtf8(next, Math.max(MIN_SOURCE_CHUNK_BYTES, Math.floor(Buffer.byteLength(current, "utf-8") / 2)))
      reducing = true
    }
    return undefined
  })
