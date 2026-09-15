export * as ProviderDispatch from "./provider-dispatch"

import { Cause, Duration, Effect, Exit, Option, Stream } from "effect"
import {
  LLM,
  LLMEvent,
  Message,
  type LLMClientShape,
  type LLMError,
  type LLMRequest,
  type Model,
  type Usage,
} from "@novaclaw/llm"
import { Log } from "@novaclaw/schema/log"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import type { SessionMessage } from "@novaclaw/schema/session-message"
import { EventV2 } from "../../event"
import { SessionSchema } from "../schema"
import { SessionScheduler } from "../scheduler"
import { ContextBudget } from "./context-budget"
import { ContextPack } from "./context-pack"
import { ProviderRetry } from "./provider-retry"
import { ReasoningBudget } from "./reasoning-budget"
import { Token } from "../../util/token"
import { applySteerProvenance } from "../steer-provenance"

const thinkingEnabled = (request: LLMRequest): boolean => {
  const body = request.http?.body as { chat_template_kwargs?: { enable_thinking?: boolean } } | undefined
  return body?.chat_template_kwargs?.enable_thinking !== false
}

/** Remove reasoning at the request boundary for every protocol shape NovaClaw owns.
 *
 * A zero officer budget is an instruction to answer without reasoning, not merely a controller
 * ceiling of zero. The controller deliberately treats zero as "do not monitor", so implementing
 * this at `ReasoningBudget` would do the opposite of what the Tune control says. */
export const withoutReasoning = (request: LLMRequest): LLMRequest => {
  const input = LLM.requestInput(request)
  return LLM.request({
    ...input,
    providerOptions: {
      ...(input.providerOptions ?? {}),
      openai: { ...(input.providerOptions?.openai ?? {}), reasoningEffort: "none" },
      anthropic: { ...(input.providerOptions?.anthropic ?? {}), thinking: { type: "disabled" } },
      gemini: {
        ...(input.providerOptions?.gemini ?? {}),
        thinkingConfig: {
          ...((input.providerOptions?.gemini?.thinkingConfig as Record<string, unknown> | undefined) ?? {}),
          thinkingBudget: 0,
          includeThoughts: false,
        },
      },
    },
    http: {
      ...(input.http ?? {}),
      body: {
        ...(input.http?.body ?? {}),
        chat_template_kwargs: {
          ...((input.http?.body?.["chat_template_kwargs"] as Record<string, unknown> | undefined) ?? {}),
          enable_thinking: false,
        },
      },
    },
  })
}

export interface PrepareInput {
  readonly request: LLMRequest
  readonly promptCacheKey: string
  readonly contextSize: number | undefined
  readonly prefixCacheRetentionTokens?: number
  /** Flattened exact-route vision patch size; the token leaf never reads config or services. */
  readonly imagePatchPixels?: number
  readonly profile?: ContextBudget.Profile
  readonly memoryRecall?: string
  readonly promptCorrectionTokens?: number
  readonly promptMarginTokens?: number
  /**
   * The compactor's response reserve, threaded so the packer and the compactor budget against ONE
   * number rather than two that agree only at some window sizes. See `ContextPack.budget`.
   */
  readonly minimumResponseReserveTokens?: number
  /**
   * Last-moment hard mode: relax the packer's never-drop rules until the result fits, and report
   * `fits`. Set only by the dispatch gate, immediately before the bytes would leave.
   */
  readonly hard?: boolean
}

/** Attach the stable cache identity and pack the exact request that will reach the provider. */
export const prepare = (input: PrepareInput) => {
  const requestInput = LLM.requestInput(input.request)
  const openai = (requestInput.providerOptions?.openai ?? {}) as Record<string, unknown>
  const cacheable = LLM.request({
    ...requestInput,
    providerOptions: {
      ...requestInput.providerOptions,
      openai: { ...openai, promptCacheKey: input.promptCacheKey },
    },
  })
  const packed = ContextPack.packRequest({
    request: cacheable,
    contextSize: input.contextSize,
    prefixCacheRetentionTokens: input.prefixCacheRetentionTokens,
    imagePatchPixels: input.imagePatchPixels,
    profile: input.profile,
    memoryRecall: input.memoryRecall,
    promptCorrectionTokens: input.promptCorrectionTokens,
    promptMarginTokens: input.promptMarginTokens,
    ...(input.minimumResponseReserveTokens === undefined
      ? {}
      : { minimumResponseReserveTokens: input.minimumResponseReserveTokens }),
  })
  const request = packed.changed
    ? LLM.request({ ...LLM.requestInput(cacheable), system: packed.system, messages: packed.messages })
    : cacheable
  return { request, packed }
}

/** The provider-neutral reasoning controller used by every dispatched completion. */
interface StreamInput {
  readonly llm: LLMClientShape
  readonly request: LLMRequest
  /** The already-packed opening request. The controller consumes this exact request. */
  readonly preparedOpening?: LLMRequest
  readonly enabled: boolean
  readonly budget: number
  /** A distinct model for the private reasoning phase. The harness owns the phase boundary. */
  readonly reasoningModel?: Model
  /** Move the scheduler lease with the provider request. A split-model turn never holds the
   * ordinary device while the reasoner is generating, and the ordinary stream cannot begin until
   * its own device has been reacquired. */
  readonly reasoningPhase?: {
    readonly enter: Effect.Effect<void>
    readonly leave: (costTokens: number | undefined) => Effect.Effect<void>
  }
  /** Refit the answer after private reasoning has been appended. The original request was packed
   * before that text existed, so reusing it verbatim can exceed the ordinary model's context. */
  readonly prepareAnswer?: (request: LLMRequest) => LLMRequest
  /** Observe the exact request/usage pair for every provider response, before a controller can
   * collapse several reasoning phases into one synthetic settlement. */
  readonly onProviderStep?: (step: {
    readonly request: LLMRequest
    readonly usage: Usage | undefined
    /** Serving-process provenance from the provider's own finish event, when it reports one. */
    readonly providerMetadata: Readonly<Record<string, unknown>> | undefined
    /** Whether this ordinary opening request can become a durable usage anchor. */
    readonly anchorable: boolean
    readonly phase: "reasoning" | "answer"
  }) => Effect.Effect<void>
}

/** Exact first provider request. Healthy turns receive no controller-authored message. */
export const openingRequest = (input: Pick<StreamInput, "request" | "enabled" | "budget">): LLMRequest =>
  input.enabled && input.budget > 0 && thinkingEnabled(input.request)
    ? ReasoningBudget.openingRequest({ request: input.request, budget: input.budget })
    : input.request

export const stream = (input: StreamInput): Stream.Stream<import("@novaclaw/llm").LLMEvent, LLMError> => {
  const source = (
    request: LLMRequest,
    observation: { readonly anchorable: boolean; readonly phase?: "reasoning" | "answer" },
  ) => {
    const stream = input.llm.stream(request)
    if (input.onProviderStep === undefined) return stream
    return stream.pipe(
      Stream.tap((event) =>
        LLMEvent.is.stepFinish(event)
          ? input.onProviderStep!({
              request,
              usage: event.usage,
              providerMetadata: event.providerMetadata,
              anchorable: observation.anchorable,
              phase: observation.phase ?? "answer",
            })
          : Effect.void,
      ),
    )
  }
  if (input.enabled && input.budget > 0 && input.reasoningModel !== undefined) {
    let reasoning = ""
    let done = false
    // Step-finish and finish normally repeat one usage value. Keep the last terminal observation,
    // exactly as ReasoningBudget does, so one provider phase is charged once rather than twice.
    let reasoningUsage: Usage | undefined
    const maxChars = Token.charsFromTokens(input.budget)
    const reasonInput = LLM.requestInput(input.request)
    // The controller, not the model, opens the private envelope. This makes the handoff deterministic
    // even for a model that would otherwise answer directly, while each provider request remains
    // bound to exactly one model and one KV cache.
    const reasonRequest = LLM.request({
      ...reasonInput,
      model: input.reasoningModel,
      tools: [],
      toolChoice: "none",
      messages: [...input.request.messages, Message.assistant("<think>\n")],
      http: {
        ...(reasonInput.http ?? {}),
        body: {
          ...(reasonInput.http?.body ?? {}),
          chat_template_kwargs: {
            ...((reasonInput.http?.body?.["chat_template_kwargs"] as Record<string, unknown> | undefined) ?? {}),
            enable_thinking: true,
          },
          continue_final_message: true,
          add_generation_prompt: false,
        },
      },
    })
    const rawReasoningSource = source(reasonRequest, { anchorable: false, phase: "reasoning" }).pipe(
      Stream.flatMap((event) => {
        if (LLMEvent.is.stepFinish(event) || LLMEvent.is.finish(event)) {
          if (event.usage !== undefined) reasoningUsage = event.usage
          return Stream.empty
        }
        if (!LLMEvent.is.reasoningDelta(event) && !LLMEvent.is.textDelta(event)) return Stream.empty
        const room = maxChars - reasoning.length
        if (room <= 0) {
          done = true
          return Stream.empty
        }
        const text = event.text.slice(0, room)
        reasoning += text
        // Text means the reasoner closed the envelope and started drafting its own answer. Keep the
        // first conclusion as evidence, then hand answer/tool generation to the ordinary model.
        if (LLMEvent.is.textDelta(event) || reasoning.length >= maxChars) done = true
        // This phase is private controller state, not assistant output. Publishing it would both
        // expose scratch work and make an answer failure look non-retryable because durable output
        // had already begun.
        return Stream.empty
      }),
      Stream.takeUntil((event) => done && LLMEvent.is.reasoningDelta(event)),
      // A prototype may point at a model/provider that cannot accept continuation prefills. The
      // officer still answers on its ordinary model; the failed private phase is never a dead end.
      Stream.catchCause(() => Stream.empty),
    )
    const reasoningSource =
      input.reasoningPhase === undefined
        ? rawReasoningSource
        : Stream.unwrap(input.reasoningPhase.enter.pipe(Effect.as(rawReasoningSource))).pipe(
            // Defer the read until the provider stream has actually produced its terminal usage.
            Stream.ensuring(Effect.suspend(() => input.reasoningPhase!.leave(reasoningUsage?.totalTokens))),
          )
    const answerSource = Stream.unwrap(
      Effect.sync(() => {
        const tail = reasoning.trim()
          ? applySteerProvenance(
              `A separate reasoning model produced the private work below. Use it as evidence, check it, then answer or call a tool. Do not repeat or expose the private reasoning.\n<thinking>\n${reasoning}\n</thinking>`,
            )
          : undefined
        const unpackedAnswer = withoutReasoning(
          LLM.request({
            ...LLM.requestInput(input.request),
            messages: [...input.request.messages, ...(tail === undefined ? [] : [Message.user(tail)])],
          }),
        )
        const answer = input.prepareAnswer?.(unpackedAnswer) ?? unpackedAnswer
        return source(answer, { anchorable: false, phase: "answer" }).pipe(
            Stream.map((event) => {
              if (!LLMEvent.is.stepFinish(event) && !LLMEvent.is.finish(event)) return event
              const usage = ReasoningBudget.aggregateUsage(
                [
                  ...(reasoningUsage === undefined ? [] : [reasoningUsage]),
                  ...(event.usage === undefined ? [] : [event.usage]),
                ],
                0,
              )
              return LLMEvent.is.stepFinish(event)
                ? LLMEvent.stepFinish({
                    index: event.index,
                    reason: event.reason,
                    usage,
                    providerMetadata: event.providerMetadata,
                  })
                : LLMEvent.finish({
                    reason: event.reason,
                    usage,
                    providerMetadata: event.providerMetadata,
                  })
            }),
          )
      }),
    )
    return Stream.concat(reasoningSource, answerSource)
  }
  return input.enabled && input.budget > 0 && thinkingEnabled(input.request)
    ? ReasoningBudget.stream({
        request: input.request,
        ...(input.preparedOpening === undefined ? {} : { preparedOpening: input.preparedOpening }),
        stream: source,
        budget: input.budget,
      })
    : source(input.request, { anchorable: true })
}

export interface Input<E, R> {
  readonly events: EventV2.Interface
  readonly scheduler: SessionScheduler.Interface
  readonly sessionID: SessionSchema.ID
  readonly slot: SessionScheduler.AdmitInput
  readonly maxAttempts: number
  /** Replaying after any visible output could duplicate text or side effects. */
  readonly hasOutput: () => boolean
  /** Fresh input + output tokens, once the attempt has settled. */
  readonly costTokens?: () => number | undefined
  /** One complete consumption of the provider stream. Reused only before output. */
  readonly attempt: Effect.Effect<void, E, R>
  /** Server-owned timing hooks. Synchronous and optional so dispatch remains reusable in Strict. */
  readonly timing?: {
    readonly queued?: () => void
    readonly admitted?: () => void
    readonly attemptStarted?: (attempt: number) => void
    readonly attemptSettled?: (attempt: number, outcome: "completed" | "failed" | "interrupted" | "retry") => void
    readonly live?: () => SessionMessage.TurnTiming
  }
}

export interface Restore {
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>
}

/**
 * The one provider-dispatch bracket shared by normal and Strict turns.
 *
 * Admission is interruptible, generation and retry sleeps are restored inside an uninterruptible
 * ownership region, and release is an unconditional finalizer. The returned Exit lets each engine
 * keep its own settlement policy without rebuilding admission or retry policy around it.
 */
const dispatch = <E, R, A, E2, R2>(
  input: Input<E, R>,
  settle: (result: Exit.Exit<void, E>, restore: Restore) => Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E2, R | R2> => {
  const publishTiming = () => {
    const live = input.timing?.live
    return live
      ? Effect.suspend(() =>
          input.events.publish(SessionStatusEvent.Status, {
            sessionID: input.sessionID,
            status: { type: "busy", timing: live() },
          }),
        ).pipe(Effect.ignore)
      : Effect.void
  }
  return Effect.sync(() => input.timing?.queued?.()).pipe(
    Effect.andThen(publishTiming()),
    Effect.andThen(input.scheduler.admit(input.slot)),
    Effect.tap(() => Effect.sync(() => input.timing?.admitted?.()).pipe(Effect.andThen(publishTiming()))),
    Effect.andThen(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let attempt = 1
          input.timing?.attemptStarted?.(attempt)
          yield* publishTiming()
          let result = yield* restore(input.attempt).pipe(Effect.exit)
          while (result._tag === "Failure" && !Cause.hasInterrupts(result.cause)) {
            if (input.hasOutput() || attempt >= input.maxAttempts) break
            const transient = Option.getOrUndefined(Cause.findErrorOption(result.cause))
            if (!ProviderRetry.isRetryableBeforeOutput(transient)) break
            input.timing?.attemptSettled?.(attempt, "retry")
            const delay = ProviderRetry.retryDelayMs(attempt, transient.retryAfterMs)
            yield* Log.event("session.provider.attempt.retry", {
              "session.id": input.sessionID,
              attempt,
              "session.attempts.max": input.maxAttempts,
              "session.provider.reason": transient.reason._tag,
              "session.provider.message": transient.message,
            })
            yield* input.events
              .publish(SessionStatusEvent.Status, {
                sessionID: input.sessionID,
                status: {
                  type: "retry",
                  attempt: attempt + 1,
                  message: ProviderRetry.statusMessage(transient),
                  next: Date.now() + delay,
                },
              })
              .pipe(Effect.ignore)
            yield* restore(Effect.sleep(Duration.millis(delay)))
            attempt++
            input.timing?.attemptStarted?.(attempt)
            yield* publishTiming()
            result = yield* restore(input.attempt).pipe(Effect.exit)
          }
          input.timing?.attemptSettled?.(
            attempt,
            result._tag === "Success" ? "completed" : Cause.hasInterrupts(result.cause) ? "interrupted" : "failed",
          )
          yield* publishTiming()
          const costTokens = result._tag === "Success" ? input.costTokens?.() : undefined
          if (costTokens !== undefined)
            yield* input.scheduler.report({
              ...input.slot,
              costTokens,
            })
          // ⭐ THE IN-BAND RELEASE. Generation is over; settlement — which is where tools RUN — must
          // not hold the device. Without this the `ensuring` net below was the only release, and it
          // fires after settlement: a parent blocked in the `wait` tool held the device against its
          // own child, which is batch class and admitted only while no interactive turn is in
          // flight. Measured 2026-08-20: the child's first step landed 599.3 s later, released by
          // the join's own 600 s timeout rather than by anything going right.
          //
          // ⚠️ Charge the ledger BEFORE releasing: `report` and `release` both address the slot, and
          // releasing first would drain a waiter that then races the charge for this turn's cost.
          //
          // The net below stays. `release` is idempotent (gated on `held`), so the second call is a
          // no-op on the success path and remains the only release on the failure and interrupt
          // paths, where this line is never reached.
          yield* input.scheduler.release(input.slot)
          return yield* settle(result, restore)
        }),
      ),
    ),
    Effect.ensuring(input.scheduler.release(input.slot)),
  )
}

export const run = <E, R>(input: Input<E, R>): Effect.Effect<Exit.Exit<void, E>, never, R> =>
  dispatch(input, (result) => Effect.succeed(result))

/** Settle the stream while the ownership mask is still installed, preserving interrupt cleanup. */
export const runAndSettle = <E, R, A, E2, R2>(
  input: Input<E, R>,
  settle: (result: Exit.Exit<void, E>, restore: Restore) => Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E2, R | R2> => dispatch(input, settle)
