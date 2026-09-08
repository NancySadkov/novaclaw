export * as ShortAnswer from "./short-answer"

import { Effect, Stream } from "effect"
import { LLM, LLMEvent, Message, SystemPart } from "@novaclaw/llm"
import { ReasoningBudget } from "./reasoning-budget"
import { SessionScheduler } from "../scheduler"

/**
 * ONE short line from a model, with thinking bounded — the shape both the chat titler and the
 * colleague status line need.
 *
 * 🔴 **Extracted because the second caller re-derived it and got it wrong** (owner, 2026-08-28:
 * *"we had the session title generation code solved this exact problem: generating a short
 * description / label fast, without thinking. Please reuse it."*). The status sweep issued its own
 * `LLM.request` with a 256-token cap and no reasoning guard; `qwen3.8-27b` returned `content: ""`
 * with the whole budget spent on `reasoning_content`, and every colleague came back "unusable".
 * The titler had solved that months earlier, three files away.
 *
 * ⚠️ `ReasoningBudget` is the load-bearing part, not the token cap. It counts reasoning deltas live,
 * nudges at 0.7× and 1× of the budget, and its mechanical hard stop re-issues the turn with thinking
 * structurally disabled (`enable_thinking=false`). A tight `max_tokens` alone does the opposite of
 * helping: a thinking model truncated inside its `<think>` block returns nothing at all, in BOTH
 * channels, because the reasoning parser only emits on the closing tag.
 *
 * ⚠️ It deliberately does NOT take the `UtilityCap` ladder the extraction passes use. `ReasoningBudget`
 * already owns a bounded multi-phase recovery for exactly this failure; stacking a second retry loop
 * on top would be two recoveries racing over one turn, which is how a bounded thing becomes unbounded.
 * A caller that explicitly supplies a ZERO reasoning budget takes the stricter path: the opening
 * request disables thinking structurally and streams that one request directly. That is for labels
 * where deliberation has no value and latency is the feature; it still enters through this shared
 * short-answer and scheduler seam rather than growing a second utility-call implementation.
 *
 * ⚠️ A recorded assumption mismatch, carried over from the titler rather than quietly dropped:
 * `reasoning-budget.ts` argues its safety from phases inheriting an UNSET `max_tokens`, so an answer
 * that starts inside a phase always completes. Callers here pass an explicit cap, so that argument
 * does not hold verbatim — the checkpoints bound REASONING, not the answer. It holds in practice only
 * because the hard stop lands far under the cap. If either number moves, this is the pairing to
 * re-check.
 */
export const generate = <E, R>(input: {
  readonly model: Parameters<typeof LLM.request>[0]["model"]
  /**
   * ⚠️ Typed by its `stream` alone, and GENERIC in that stream's error and requirement. Annotating
   * this `LLMClient.Interface` flattened both to `unknown`, which no caller can discharge — the
   * status sweep's `Effect.provide(located)` then could not prove it had satisfied anything.
   */
  readonly llm: { readonly stream: (request: ReturnType<typeof LLM.request>) => Stream.Stream<LLMEvent, E, R> }
  readonly system: string
  readonly text: string
  /** Reasoning ceiling. Zero disables thinking on the opening request; 128 allows brief deliberation. */
  readonly reasoningBudget: number
  /** Answer ceiling. Kept well above the hard stop's measured landing point. */
  readonly maxTokens: number
  /** Decode-shaped utility work always enters through the device's interactive-idle tier. */
  readonly scheduler: SessionScheduler.Interface
  readonly maintenance: SessionScheduler.MaintenanceInput
}) =>
  // ⚠️ The return type is INFERRED, deliberately. Annotating it `Effect<string>` claimed the call
  // needs nothing; annotating it `unknown` made it undischargeable by any caller. What it actually
  // requires is whatever `ReasoningBudget` requires — a location's services — which the status
  // sweep discharges with `Effect.provide(located)` and the titler already has in scope.
  SessionScheduler.runMaintenance(
    input.scheduler,
    input.maintenance,
    Effect.gen(function* () {
      const chunks: string[] = []
      const request = LLM.request({
        model: input.model,
        system: [SystemPart.make(input.system)],
        messages: [Message.user(input.text)],
        tools: [],
        generation: { maxTokens: input.maxTokens },
        ...(input.reasoningBudget <= 0
          ? {
              http: {
                body: {
                  chat_template_kwargs: { enable_thinking: false },
                },
              },
            }
          : {}),
      })
      const stream =
        input.reasoningBudget <= 0
          ? input.llm.stream(request)
          : ReasoningBudget.stream({
              request,
              stream: (next) => input.llm.stream(next),
              budget: input.reasoningBudget,
            })
      yield* stream.pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
      )
      // ⚠️ Raw. Every caller has its own idea of what "usable" means — a title tolerates 100
      // characters, a contacts row 60 — so the cleaning stays with the caller and this returns exactly
      // what the model said, empty string included. An empty completion is a broken call, and a caller
      // that cannot tell it from a blank answer cannot say so.
      return chunks.join("")
    }),
    Effect.succeed(""),
  )
