export * as ProviderDispatch from "./provider-dispatch"

import { Cause, Duration, Effect, Exit, Option, Stream } from "effect"
import { LLM, type LLMClientShape, type LLMError, type LLMRequest } from "@novaclaw/llm"
import { Log } from "@novaclaw/schema/log"
import { SessionStatusEvent } from "@novaclaw/schema/session-status-event"
import { EventV2 } from "../../event"
import { SessionSchema } from "../schema"
import { SessionScheduler } from "../scheduler"
import { ContextBudget } from "./context-budget"
import { ContextPack } from "./context-pack"
import { ProviderRetry } from "./provider-retry"
import { ReasoningBudget } from "./reasoning-budget"

const thinkingEnabled = (request: LLMRequest): boolean => {
  const body = request.http?.body as { chat_template_kwargs?: { enable_thinking?: boolean } } | undefined
  return body?.chat_template_kwargs?.enable_thinking !== false
}

export interface PrepareInput {
  readonly request: LLMRequest
  readonly promptCacheKey: string
  readonly contextSize: number | undefined
  readonly profile?: ContextBudget.Profile
  readonly memoryRecall?: string
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
    profile: input.profile,
    memoryRecall: input.memoryRecall,
  })
  const request = packed.changed
    ? LLM.request({ ...LLM.requestInput(cacheable), system: packed.system, messages: packed.messages })
    : cacheable
  return { request, packed }
}

/** The provider-neutral reasoning controller used by every dispatched completion. */
export const stream = (input: {
  readonly llm: LLMClientShape
  readonly request: LLMRequest
  readonly enabled: boolean
  readonly budget: number
}): Stream.Stream<import("@novaclaw/llm").LLMEvent, LLMError> =>
  input.enabled && input.budget > 0 && thinkingEnabled(input.request)
    ? ReasoningBudget.stream({
        request: input.request,
        stream: (request) => input.llm.stream(request),
        budget: input.budget,
      })
    : input.llm.stream(input.request)

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
): Effect.Effect<A, E2, R | R2> =>
  input.scheduler.admit(input.slot).pipe(
    Effect.andThen(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let attempt = 1
          let result = yield* restore(input.attempt).pipe(Effect.exit)
          while (result._tag === "Failure" && !Cause.hasInterrupts(result.cause)) {
            if (input.hasOutput() || attempt >= input.maxAttempts) break
            const transient = Option.getOrUndefined(Cause.findErrorOption(result.cause))
            if (!ProviderRetry.isRetryableBeforeOutput(transient)) break
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
            yield* input.events
              .publish(SessionStatusEvent.Status, {
                sessionID: input.sessionID,
                status: { type: "busy" },
              })
              .pipe(Effect.ignore)
            result = yield* restore(input.attempt).pipe(Effect.exit)
          }
          const costTokens = result._tag === "Success" ? input.costTokens?.() : undefined
          if (costTokens !== undefined)
            yield* input.scheduler.report({
              ...input.slot,
              costTokens,
            })
          return yield* settle(result, restore)
        }),
      ),
    ),
    Effect.ensuring(input.scheduler.release(input.slot)),
  )

export const run = <E, R>(input: Input<E, R>): Effect.Effect<Exit.Exit<void, E>, never, R> =>
  dispatch(input, (result) => Effect.succeed(result))

/** Settle the stream while the ownership mask is still installed, preserving interrupt cleanup. */
export const runAndSettle = <E, R, A, E2, R2>(
  input: Input<E, R>,
  settle: (result: Exit.Exit<void, E>, restore: Restore) => Effect.Effect<A, E2, R2>,
): Effect.Effect<A, E2, R | R2> => dispatch(input, settle)
