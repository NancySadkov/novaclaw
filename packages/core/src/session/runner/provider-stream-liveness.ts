export * as ProviderStreamLiveness from "./provider-stream-liveness"

import { InvalidProviderOutputReason, LLMError, TransportReason } from "@novaclaw/llm"
import { Duration, Stream } from "effect"

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
      orElse: () =>
        Stream.fail(
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
          }),
        ),
    }),
  )
}
