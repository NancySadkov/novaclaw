export * as ProviderStreamLiveness from "./provider-stream-liveness"

import { InvalidProviderOutputReason, LLMError, TransportReason } from "@novaclaw/llm"
import { Duration, Effect, Stream } from "effect"

const stallError = (timeoutMs: number, hasOutput: () => boolean) =>
  new LLMError({
    module: "SessionRunner",
    method: "stream",
    reason: hasOutput()
      ? new InvalidProviderOutputReason({
          message:
            `The model reply stopped partway through for ${Math.round(timeoutMs / 1000)} seconds. ` +
            "NovaClaw closed the incomplete reply so it could continue safely.",
        })
      : new TransportReason({
          kind: "Timeout",
          message:
            `The model server sent no data for ${Math.round(timeoutMs / 1000)} seconds. ` +
            "NovaClaw stopped waiting so this turn would not hang indefinitely.",
        }),
  })

/**
 * Bound provider INACTIVITY without bounding a long, healthy generation. `Stream.timeoutOrElse`
 * restarts its timer after every element, so reasoning/text events are heartbeats as well as data.
 */
export function withStallTimeout<A, E, R>(
  source: Stream.Stream<A, E, R>,
  timeoutMs: number,
  hasOutput: () => boolean = () => false,
) {
  return source.pipe(
    Stream.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () => Stream.fail(stallError(timeoutMs, hasOutput)),
    }),
  )
}

/**
 * Consume a provider stream with one liveness envelope around BOTH halves of the boundary.
 *
 * `Stream.timeoutOrElse` only times upstream pulls. A provider event can therefore be received and
 * durably committed, then hang in projection/notification while the pull timer is no longer running.
 * Time each event's consumer as well. Durable commits are already uninterruptible, so the timeout
 * cannot tear a transaction in half; it only regains control after the commit boundary and lets the
 * runner settle the incomplete assistant turn and release its scheduler reservation.
 */
export function runForEach<A, E, R, E2, R2>(
  source: Stream.Stream<A, E, R>,
  timeoutMs: number,
  hasOutput: () => boolean,
  consume: (value: A) => Effect.Effect<void, E2, R2>,
) {
  return withStallTimeout(source, timeoutMs, hasOutput).pipe(
    Stream.runForEach((value) =>
      consume(value).pipe(
        Effect.timeoutOrElse({
          duration: Duration.millis(timeoutMs),
          orElse: () => Effect.fail(stallError(timeoutMs, hasOutput)),
        }),
      ),
    ),
  )
}
