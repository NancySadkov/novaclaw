export * as ReasoningBudget from "./reasoning-budget"

import { Stream, Effect } from "effect"
import { LLM, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import type { FinishReason, LLMRequest, StepFinish } from "@novaclaw/llm"

/**
 * MindControl-style thinking-budget controller (notes/experimental.md, owner ask 2026-07-24).
 *
 * MindControl is a llama.cpp *sampler* fork that injects self-aware nudges into a model's `<think>`
 * stream to stop small models rambling/looping. NovaClaw talks to vLLM over a one-way HTTP stream,
 * so we can't inject into a live generation — the faithful adaptation is **stop-at-checkpoint →
 * continue with the nudge prefilled** (`continue_final_message`), verified against the live
 * qwen3.6-35b. Three checkpoints:
 *
 *   1. **Opening** — a system-prompt line primes the model to keep reasoning within the budget.
 *      (MindControl prefills this into `<think>`; a client can't force that safely on non-thinking
 *      models, so we make it an honest instruction the model actually receives.)
 *   2. **~70%** — the first phase runs the NORMAL request. We count reasoning tokens from the live
 *      `reasoning` deltas and, once they cross 0.7·budget while still thinking, tear the request down
 *      and CONTINUE the reasoning by prefilling `<think>\n{reasoning so far}\n{mid nudge}\n`.
 *   3. **Budget end** — the next phase stops when reasoning crosses the full budget; then it injects
 *      a real `</think>` close + end nudge and continues, forcing the answer out (this avoids the
 *      empty-reply trap where truncating an *unclosed* `<think>` returns nothing — jh think-stage.md).
 *
 * Each phase's `max_tokens` stays GENEROUS (the output limit): the budget is enforced by the
 * mid-stream checkpoint, never by `max_tokens`, so an answer that starts inside a phase always
 * completes rather than being guillotined. A model that finishes reasoning on its own (emits answer
 * `content`) short-circuits with NO continuation — the common, cheap path, and the reason phase 1
 * carries no prefill: a non-thinking model just answers and the mechanism is a no-op. The whole turn
 * is stitched into a single assistant message: one reasoning block (model reasoning + injected
 * nudges) then one text block (the answer). Reasoning tokens ride the `reasoning` streaming delta.
 */

const REASON_ID = "reasoning-0"
const TEXT_ID = "text-0"
const MID_RATIO = 0.7

export interface Nudges {
  /** System-prompt priming line (checkpoint 1). */
  readonly opening: (budget: number) => string
  /** Injected into the reasoning at ~70% of budget (checkpoint 2). */
  readonly mid: string
  /** Injected with the `</think>` close at budget end (checkpoint 3). */
  readonly end: string
}

export const defaultNudges: Nudges = {
  opening: (budget) =>
    `You have a reasoning budget of about ${budget} tokens for your <think> block this turn. Keep your reasoning concise and focused, don't go in circles, and stop thinking once you can answer.`,
  mid: "I've used most of my reasoning budget — let me stop exploring and work towards a conclusion now.",
  end: "I've reached the end of my thinking budget. I'll stop reasoning and give the user my answer now.",
}

type Phase = "opening" | "mid" | "end"

/** Rough chars-per-token for the live reasoning-budget estimate — the checkpoint is approximate. */
const CHARS_PER_TOKEN = 4

interface State {
  /** The `<think>` interior accumulated so far (streamed model reasoning + injected nudges); the
   *  prefill body of each continuation request. */
  think: string
  reasoningStarted: boolean
  reasoningEnded: boolean
  inAnswer: boolean
  /** The current phase reached its reasoning ceiling while still thinking — advance + nudge. */
  checkpointHit: boolean
  /** Reasoning ended via a non-text action (tool call) — finalize without a text block. */
  done: boolean
  finish: FinishReason
  usage: StepFinish["usage"]
  stop: boolean
}

export interface Input<E, R> {
  readonly request: LLMRequest
  readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, E, R>
  readonly budget: number
  readonly nudges?: Nudges
}

/**
 * Wrap a provider turn in the thinking-budget controller. Drop-in for `llm.stream(request)`:
 * yields the same `LLMEvent` stream (one reasoning block, one text block) so the runner's publisher
 * is unchanged.
 */
export const stream = <E, R>(input: Input<E, R>): Stream.Stream<LLMEvent, E, R> => {
  const nudges = input.nudges ?? defaultNudges
  const system = [...input.request.system, SystemPart.make(nudges.opening(input.budget))]
  const state: State = {
    think: "",
    reasoningStarted: false,
    reasoningEnded: false,
    inAnswer: false,
    checkpointHit: false,
    done: false,
    finish: "stop",
    usage: undefined,
    stop: false,
  }
  // Cumulative reasoning-token ceiling for the CURRENT phase (opening ~0.7·budget, mid = full budget,
  // end = none). Set by `runPhase` before each phase streams.
  let checkpoint = Infinity
  const reasoningTokens = () => Math.ceil(state.think.length / CHARS_PER_TOKEN)

  // Append reasoning text to the prefill accumulator AND surface it as a reasoning delta (opening
  // the block on first use). Used for both streamed model reasoning and the injected nudges.
  const emitReasoning = (text: string): LLMEvent[] => {
    const out: LLMEvent[] = []
    if (!state.reasoningStarted) {
      out.push(LLMEvent.reasoningStart({ id: REASON_ID }))
      state.reasoningStarted = true
    }
    state.think += text
    out.push(LLMEvent.reasoningDelta({ id: REASON_ID, text }))
    return out
  }

  const beginAnswer = (out: LLMEvent[]): void => {
    if (state.inAnswer) return
    if (state.reasoningStarted && !state.reasoningEnded) {
      out.push(LLMEvent.reasoningEnd({ id: REASON_ID }))
      state.reasoningEnded = true
    }
    out.push(LLMEvent.textStart({ id: TEXT_ID }))
    state.inAnswer = true
  }

  // Relabel each phase's raw events onto the single shared reasoning/text blocks, and swallow the
  // per-phase lifecycle (start/end/step-finish) — the controller emits its own overarching one.
  const transform = (event: LLMEvent): LLMEvent[] => {
    if (LLMEvent.is.reasoningDelta(event)) {
      const out = emitReasoning(event.text)
      // Reached the phase's reasoning ceiling while still thinking → flag the checkpoint abort.
      if (!state.inAnswer && reasoningTokens() >= checkpoint) state.checkpointHit = true
      return out
    }
    if (LLMEvent.is.textDelta(event)) {
      const out: LLMEvent[] = []
      beginAnswer(out)
      out.push(LLMEvent.textDelta({ id: TEXT_ID, text: event.text }))
      return out
    }
    if (LLMEvent.is.stepFinish(event)) {
      state.finish = event.reason
      if (event.usage) state.usage = event.usage
      return []
    }
    if (
      LLMEvent.is.finish(event) ||
      LLMEvent.is.stepStart(event) ||
      LLMEvent.is.reasoningStart(event) ||
      LLMEvent.is.reasoningEnd(event) ||
      LLMEvent.is.textStart(event) ||
      LLMEvent.is.textEnd(event)
    )
      return []
    if (LLMEvent.is.providerError(event)) {
      state.stop = true
      return [event]
    }
    // Tool calls (and any other content event) mean the model has stopped reasoning and is acting:
    // close the reasoning block, mark done (no text block), forward the event, and finalize.
    const out: LLMEvent[] = []
    if (state.reasoningStarted && !state.reasoningEnded) {
      out.push(LLMEvent.reasoningEnd({ id: REASON_ID }))
      state.reasoningEnded = true
    }
    state.done = true
    out.push(event)
    return out
  }

  const finalize = (): Stream.Stream<LLMEvent, E, R> => {
    const out: LLMEvent[] = []
    if (state.reasoningStarted && !state.reasoningEnded) {
      out.push(LLMEvent.reasoningEnd({ id: REASON_ID }))
      state.reasoningEnded = true
    }
    if (state.inAnswer) out.push(LLMEvent.textEnd({ id: TEXT_ID }))
    out.push(LLMEvent.stepFinish({ index: 0, reason: state.finish, usage: state.usage }))
    return Stream.fromIterable(out)
  }

  const phaseRequest = (phase: Phase): LLMRequest => {
    // Inherit the base request's own token limit (typically UNSET → the server allocates the whole
    // remaining context window). The reasoning is bounded by the mid-stream checkpoint abort, NOT by
    // max_tokens (a tight cap truncates answers, and truncating an unclosed `<think>` returns nothing
    // — jh think-stage.md). ⚠️ Do NOT force an explicit max_tokens here: on a long turn whose packed
    // prompt sits near the context limit, `prompt_tokens + max_tokens` overflows the window and the
    // provider 400s ("maximum context length"). Leaving it unset lets the server clamp output to what
    // actually fits — which is also the most generous cap available.
    const base = {
      ...LLM.requestInput(input.request),
      system,
    }
    // Phase 1 runs the model normally (no forced `<think>`) so non-thinking models simply answer.
    if (phase === "opening") return LLM.request(base)
    // mid CONTINUES the accumulated `<think>` (kept OPEN) after the injected nudge; end injects a
    // real `</think>` close so the model is forced out into its answer.
    const prefill = phase === "end" ? `<think>\n${state.think}\n</think>\n\n` : `<think>\n${state.think}\n`
    return LLM.request({
      ...base,
      messages: [...input.request.messages, Message.assistant(prefill)],
      // vLLM continuation: keep our prefilled assistant turn as the running generation instead of
      // starting a fresh one. Merged over any model-default http.body (min_p, repetition_penalty…).
      http: {
        ...(input.request.http ?? {}),
        body: {
          ...(input.request.http?.body ?? {}),
          continue_final_message: true,
          add_generation_prompt: false,
        },
      },
    })
  }

  const runPhase = (phase: Phase): Stream.Stream<LLMEvent, E, R> => {
    checkpoint = phase === "opening" ? input.budget * MID_RATIO : phase === "mid" ? input.budget : Infinity
    state.checkpointHit = false
    const source = input.stream(phaseRequest(phase)).pipe(
      Stream.flatMap((event) => Stream.fromIterable(transform(event))),
      // Stop consuming (tearing down the request) right after the reasoning delta that crosses the
      // phase ceiling. Gating on the delta (not any event) keeps the crossing delta from being
      // dropped when it shares a batch with the block's `reasoning-start`.
      Stream.takeUntil((event) => state.checkpointHit && LLMEvent.is.reasoningDelta(event)),
      Stream.concat(Stream.unwrap(Effect.sync(() => decide(phase)))),
    )
    // A CONTINUATION phase (mid/end) rides vLLM-specific flags (`continue_final_message`) and a
    // prompt+prefill that some backends won't accept. If it fails — an unsupported provider, a
    // transient error — degrade gracefully by closing out the reasoning we already have, rather than
    // failing the whole turn with a raw provider error. The opening phase is the normal request; let
    // ITS errors propagate to the runner's pre-stream retry path.
    return phase === "opening" ? source : source.pipe(Stream.catchCause(() => finalize()))
  }

  const decide = (phase: Phase): Stream.Stream<LLMEvent, E, R> => {
    if (state.stop || state.done) return finalize()
    // The model produced an answer (which completed under the generous cap) → done.
    if (state.inAnswer) return finalize()
    // Aborted at the reasoning ceiling, still thinking → inject the nudge and continue.
    if (state.checkpointHit) {
      if (phase === "opening") return prepend(emitReasoning("\n" + nudges.mid + "\n"), runPhase("mid"))
      if (phase === "mid") return prepend(emitReasoning("\n" + nudges.end + "\n"), runPhase("end"))
      return finalize()
    }
    // Reasoning ended on its own without an answer (rare) → force the answer once.
    if (phase !== "end") return prepend(emitReasoning("\n" + nudges.end + "\n"), runPhase("end"))
    return finalize()
  }

  return runPhase("opening")
}

const prepend = <E, R>(events: LLMEvent[], rest: Stream.Stream<LLMEvent, E, R>): Stream.Stream<LLMEvent, E, R> =>
  Stream.concat(Stream.fromIterable(events), rest)
