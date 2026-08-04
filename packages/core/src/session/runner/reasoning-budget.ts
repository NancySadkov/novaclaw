export * as ReasoningBudget from "./reasoning-budget"

import { Stream, Effect } from "effect"
import { LLM, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import type { FinishReason, LLMRequest, StepFinish } from "@novaclaw/llm"
import { Token } from "../../util/token"

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
 *   3. **Budget end** — the next phase stops when reasoning crosses the full budget; it injects a
 *      stronger end nudge into the still-OPEN `<think>` and continues, prompting the model to wrap up
 *      and answer on its own. (We deliberately do NOT prefill a *closed* `</think>`: qwen's chat
 *      template strips complete think blocks, which empties the message and 400s the continuation.)
 *   4. **Hard stop** — the mechanical backstop. A model in a degenerate loop reasons straight THROUGH
 *      both nudges (owner report 2026-07-25: a repeating-digit loop ran ~400x over budget), because a
 *      nudge is only INFORMATIONAL. So the end phase is itself bounded, and crossing it re-issues the
 *      turn with thinking structurally DISABLED (`chat_template_kwargs.enable_thinking=false`) — the
 *      template cannot open a `<think>` block at all, so the model must answer. Probed live against
 *      qwen3.6-35b: streaming with the flag returns a real answer, while a closed-`</think>` prefill
 *      returns an empty completion (and thinking-on with a tight max_tokens returns NOTHING at all —
 *      the empty-reply trap). **Invariant: every phase has a FINITE ceiling and the chain is finite,
 *      so a turn always terminates.**
 *
 * Each phase inherits the base request's own `max_tokens` (typically UNSET → the server uses the
 * remaining context window): the budget is enforced by the mid-stream checkpoint, never by
 * `max_tokens`, so an answer that starts inside a phase always completes rather than being
 * guillotined, and `prompt + max_tokens` can never overflow the window. A model that finishes
 * reasoning on its own (emits answer
 * `content`) short-circuits with NO continuation — the common, cheap path, and the reason phase 1
 * carries no prefill: a non-thinking model just answers and the mechanism is a no-op. The whole turn
 * is stitched into a single assistant message: one reasoning block (model reasoning + injected
 * nudges) then one text block (the answer). Reasoning tokens ride the `reasoning` streaming delta.
 */

const REASON_ID = "reasoning-0"
const TEXT_ID = "text-0"
const MID_RATIO = 0.7
/** The end phase's own ceiling — the grace a model gets to wrap up AFTER the end nudge. */
const END_RATIO = 1.5
/** The hard-stop phase's ceiling. Thinking is disabled there, so this only catches a backend that
 *  ignores the flag; crossing it finalizes rather than continuing. */
const HARD_RATIO = 2

export interface Nudges {
  /** System-prompt priming line (checkpoint 1). */
  readonly opening: (budget: number) => string
  /** Injected into the reasoning at ~70% of budget (checkpoint 2). */
  readonly mid: string
  /** Injected into the still-open `<think>` at budget end (checkpoint 3) to force a conclusion. */
  readonly end: string
  /** System line for the mechanical hard stop (checkpoint 4), where thinking is disabled outright. */
  readonly exhausted: string
}

export const defaultNudges: Nudges = {
  opening: (budget) =>
    `You have a reasoning budget of about ${budget} tokens for your <think> block this turn. Keep your reasoning concise and focused, don't go in circles, and stop thinking once you can answer.`,
  mid: "I've used most of my reasoning budget — let me stop exploring and work towards a conclusion now.",
  end: "I've reached the end of my thinking budget. I'll stop reasoning and give the user my answer now.",
  exhausted:
    "You already spent your entire reasoning budget on this turn and did not reach an answer — your reasoning had begun repeating itself. Do NOT reason further. Answer the user directly now with your best current answer, or call a tool. If you are unsure, say briefly what you established and what is still unresolved.",
}

type Phase = "opening" | "mid" | "end" | "hard"

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
  // O(1) per delta (called on every reasoning chunk): the shared char-count estimate, not the
  // CJK-aware text scan, so the checkpoint stays cheap over a long think. The budget is a SOFT cap.
  const reasoningTokens = () => Token.estimateFromChars(state.think.length)

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
      // Cut the crossing delta at the ceiling rather than swallowing it whole: a provider that batches
      // its stream (or a loop emitting one enormous chunk) would otherwise blow straight past the cap,
      // and the overshoot also rides into the next phase's prefill. Truncating keeps the cap HARD and
      // the prefill bounded — we're abandoning this reasoning anyway.
      if (!state.inAnswer && Number.isFinite(checkpoint)) {
        const room = Token.charsFromTokens(checkpoint) - state.think.length
        if (room <= 0) {
          state.checkpointHit = true
          return []
        }
        if (event.text.length > room) {
          const out = emitReasoning(event.text.slice(0, room))
          state.checkpointHit = true
          return out
        }
      }
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
    // Checkpoint 4 — the MECHANICAL hard stop. Both nudges were ignored (a degenerate loop reasons
    // right through informational text), so stop asking and remove the capability: re-issue the turn
    // with the thinking template switched OFF. No prefill — a closed-`</think>` continuation returns an
    // EMPTY completion on qwen (probed live), whereas a clean request with the flag answers normally.
    // The reasoning already streamed to the user is kept in OUR block; we simply don't feed the runaway
    // back to the model. A backend that ignores the flag is still caught by this phase's own ceiling.
    if (phase === "hard")
      return LLM.request({
        ...base,
        system: [...system, SystemPart.make(nudges.exhausted)],
        http: {
          ...(input.request.http ?? {}),
          body: {
            ...(input.request.http?.body ?? {}),
            chat_template_kwargs: {
              ...((input.request.http?.body?.["chat_template_kwargs"] as Record<string, unknown>) ?? {}),
              enable_thinking: false,
            },
          },
        },
      })
    // Both continuations keep the `<think>` block OPEN and rely on the injected nudge to make the model
    // wrap up and answer on its own. ⚠️ Do NOT prefill a CLOSED `<think>…</think>`: qwen's chat template
    // STRIPS complete think blocks from the assistant message, so a closed prefill leaves an EMPTY final
    // message and vLLM rejects the continuation ("continue_final_message is set but the final message
    // does not appear in the chat after applying the chat template"). An open block has no close tag to
    // match, so it survives — verified live. With max_tokens unset (above) the model reasons then
    // answers without the empty-reply truncation the old forced `</think>` close used to guard against.
    const prefill = `<think>\n${state.think}\n`
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
    // EVERY phase is bounded — an unbounded final phase was the runaway bug (owner report 2026-07-25):
    // the model blew its budget, got nudged, and then reasoned forever because nothing capped it.
    checkpoint =
      phase === "opening"
        ? input.budget * MID_RATIO
        : phase === "mid"
          ? input.budget
          : phase === "end"
            ? input.budget * END_RATIO
            : input.budget * HARD_RATIO
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
    // Aborted at the reasoning ceiling, still thinking → escalate.
    if (state.checkpointHit) {
      if (phase === "opening") return prepend(emitReasoning("\n" + nudges.mid + "\n"), runPhase("mid"))
      if (phase === "mid") return prepend(emitReasoning("\n" + nudges.end + "\n"), runPhase("end"))
      // Both nudges ignored → stop nudging and take the capability away (thinking disabled).
      if (phase === "end") return runPhase("hard")
      // Even the hard stop kept reasoning (a backend that ignores the flag) → end the turn. This is
      // the terminating leaf: `hard` never re-enters, so the phase chain is finite by construction.
      return finalize()
    }
    // Reasoning ended on its own without an answer (rare) → force the answer once.
    if (phase === "opening" || phase === "mid") return prepend(emitReasoning("\n" + nudges.end + "\n"), runPhase("end"))
    // The end phase closed without answering → one mechanical attempt, then finalize.
    if (phase === "end") return runPhase("hard")
    return finalize()
  }

  return runPhase("opening")
}

const prepend = <E, R>(events: LLMEvent[], rest: Stream.Stream<LLMEvent, E, R>): Stream.Stream<LLMEvent, E, R> =>
  Stream.concat(Stream.fromIterable(events), rest)
