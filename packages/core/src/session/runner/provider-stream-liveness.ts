export * as ProviderStreamLiveness from "./provider-stream-liveness"

import { LLMError, TransportReason } from "@novaclaw/llm"
import { Duration, Stream } from "effect"

/**
 * Bound provider INACTIVITY without bounding a long, healthy generation. `Stream.timeoutOrElse`
 * restarts its timer after every element, so reasoning/text events are heartbeats as well as data.
 */
export function withStallTimeout<A, E, R>(source: Stream.Stream<A, E, R>, timeoutMs: number) {
  return source.pipe(
    Stream.timeoutOrElse({
      duration: Duration.millis(timeoutMs),
      orElse: () =>
        Stream.fail(
          new LLMError({
            module: "SessionRunner",
            method: "stream",
            reason: new TransportReason({
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
