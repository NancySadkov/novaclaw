import { LLMEvent, type FinishReason, type ProviderMetadata, type Usage } from "../../schema"
import { isRecord, ProviderShared } from "../shared"
import { Lifecycle } from "./lifecycle"
import { ToolStream } from "./tool-stream"
import { truncatedArgsInput } from "./truncated-args"

/**
 * The shared policy for **the end of a framed stream**, in the one form every protocol's `onHalt`
 * can use.
 *
 * 🔴 **A stream can end before its terminal event, and that end is not always an error.** A server
 * that closes the response body after its last content chunk — no `finish_reason`, no
 * `message_delta`, no `response.completed`, no transport fault — halts a parser with blocks still
 * open and tool calls still accumulating. Emitting nothing there drops the pending calls, leaves
 * every open reasoning/text block unclosed, and — because the stream *succeeded* — hands the layer
 * above no error to react to either. The turn simply stops, and reads as a turn that had nothing to
 * say: `notes/reports/decisions-v0.2.0.md` ruling 2 (*a failed mutation never reports success*),
 * broken at the protocol seam.
 *
 * ⚠️ **The liveness guard does not cover this**, and that is why it looked covered: it bounds
 * INACTIVITY, and a stream that ends cleanly and early is never inactive.
 *
 * This module exists because the policy is a PROPERTY OF THE SEAM, not of a wire. It was first
 * written inside one protocol's `onHalt`; the other three then had the same seam and three different
 * answers to it (two had no `onHalt` at all). One implementation is what stops them drifting apart
 * again — the same argument `classify` makes for 4xx bodies in `provider-error.ts`.
 */

/**
 * The parse-error text carried by the recoverable sentinel when a call's arguments were still
 * streaming as the wire ended. It names the real cause where the output-limit case names its own;
 * ⚠️ the settle path's prescription is the SAME either way ("build the file in chunks"), because a
 * half-streamed large write has the same fix whether the ceiling or the socket ended it — this text
 * is what stops the transcript describing the second fault as the first.
 */
export const CUT_STREAM_ARGS = "the model stream ended before the tool call's arguments were complete"

/**
 * Parse tool-call arguments that are already believed to be JSON, defensively: a freak value can
 * never throw inside a decoder, and a non-object parses to `{}` rather than to a primitive the
 * tool layer would then have to defend against.
 */
export const safeParseArgs = (json: string): Record<string, unknown> => {
  try {
    const value = JSON.parse(json)
    return isRecord(value) ? value : {}
  } catch {
    return {}
  }
}

/**
 * Finalize every tool call still accumulating when the stream ended.
 *
 * Mirrors `ToolStream.finishAllRecoverable`'s policy — complete arguments parse normally, arguments
 * the wire cut mid-object ride the recoverable sentinel — in a SYNCHRONOUS form, because
 * `ProtocolStream.onHalt` is a pure `(state) => events` by contract and cannot run an Effect.
 * `repairToolJson` is total (it answers `"{}"` when nothing is recoverable) and `safeParseArgs`
 * cannot throw, so this flush has no failure arm to drop a call into.
 */
export const flushPendingToolCalls = <K extends string | number>(
  tools: ToolStream.State<K>,
): ReadonlyArray<LLMEvent> => {
  const events: LLMEvent[] = []
  const pending = Object.values<ToolStream.PendingTool | undefined>(tools)
  for (const tool of pending) {
    if (tool === undefined) continue
    events.push(
      LLMEvent.toolInputEnd({ id: tool.id, name: tool.name, providerMetadata: tool.providerMetadata }),
      LLMEvent.toolCall({
        id: tool.id,
        name: tool.name,
        input: ProviderShared.isTruncatedToolArgs(tool.input)
          ? truncatedArgsInput(CUT_STREAM_ARGS)
          : safeParseArgs(ProviderShared.repairToolJson(tool.input)),
        providerExecuted: tool.providerExecuted ? true : undefined,
        providerMetadata: tool.providerMetadata,
      }),
    )
  }
  return events
}

export interface HaltInput {
  /** The parser's lifecycle state at the halt. Its open blocks are what `Lifecycle.finish` closes. */
  readonly lifecycle: Lifecycle.State
  /**
   * Tool-call events this halt recovered (typically `flushPendingToolCalls`, plus anything the
   * protocol had already finalized), emitted before the close.
   */
  readonly toolCallEvents?: ReadonlyArray<LLMEvent>
  /**
   * Whether the turn delivered ANY tool call. Defaults to `toolCallEvents` being non-empty; a
   * protocol that emits complete calls during `step` and keeps no accumulator (Gemini) must pass its
   * own flag, or the halt would close the turn as if the model had said nothing.
   */
  readonly hasToolCalls?: boolean
  /** The reason the wire gave, if it gave one. `undefined` is the cut-stream case. */
  readonly finishReason?: FinishReason
  readonly usage?: Usage
  readonly providerMetadata?: ProviderMetadata
  /**
   * Force the close even when nothing else was produced. For a wire whose tail can carry accounting
   * and nothing else, where the caller of `generate` must still see a terminal event.
   */
  readonly close?: boolean
}

/**
 * The events a protocol's `onHalt` emits: the recovered tool calls, then the close.
 *
 * The synthesized reason says which of two things happened: `"tool-calls"` when the halt recovered
 * work to do (the loop continues, the same call the truncated-args path already makes), `"error"`
 * when it recovered nothing (the turn closes naming a fault rather than a completion). ⚠️ That
 * `"error"` is load-bearing upstream — `core/src/session/runner/llm.ts` reads a settlement of
 * `"error"` as *"the halt recovered nothing"* and continues a truncated reply on it; any other
 * vocabulary here would present the truncation as a finished turn.
 *
 * ⚠️ **The one halt this must NOT speak for is a stream that produced nothing at all.** An empty
 * body is already answered one layer up — the runner publishes a named, retryable
 * `InvalidProviderOutput` for a successful stream that started no assistant — and synthesizing a
 * settlement here would mint an empty assistant message alongside it. The guard is therefore "did
 * this turn produce anything", never "did the wire say why it stopped".
 */
export const haltEvents = (input: HaltInput): LLMEvent[] => {
  const events: LLMEvent[] = []
  const toolCallEvents = input.toolCallEvents ?? []
  const hasToolCalls = input.hasToolCalls ?? toolCallEvents.length > 0
  // A model that emits a tool call but reports finish="stop", or dumps the call into
  // text, must still continue the loop instead of halting — synthesize "tool-calls".
  const reason: FinishReason =
    input.finishReason === undefined
      ? hasToolCalls
        ? "tool-calls"
        : "error"
      : input.finishReason === "stop" && hasToolCalls
        ? "tool-calls"
        : input.finishReason
  const lifecycle = hasToolCalls ? Lifecycle.stepStart(input.lifecycle, events) : input.lifecycle
  events.push(...toolCallEvents)
  if (input.finishReason !== undefined || hasToolCalls || input.lifecycle.stepStarted || input.close === true)
    Lifecycle.finish(lifecycle, events, {
      reason,
      usage: input.usage,
      providerMetadata: input.providerMetadata,
    })
  return events
}

export * as Halt from "./halt"
