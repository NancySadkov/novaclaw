export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Cause, Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/unstable/http"
import { OtlpSerialization } from "effect/unstable/observability"
import { Global } from "./global"
import { checkUrl, loadPolicy } from "./offline"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"
import { CalloutPolicy } from "./callout-policy"

// OFF-B (layer 4): the OTLP exporters run their own FetchHttpClient, so the
// OFF-A chokepoint cannot see them. In offline mode, telemetry export is
// dropped entirely unless the configured collector endpoint passes the host
// policy (a LAN collector stays allowed via NOVACLAW_OFFLINE_ALLOW/loopback).
function otlpAllowed(): boolean {
  const policy = loadPolicy({ configDir: Global.make().config })
  if (!policy.enabled) return true
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"]
  if (!endpoint) return false
  return checkUrl(endpoint, policy).allowed
}

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const otlp = otlpAllowed()
    const logs = Logger.layer(otlp ? [...Logging.loggers(), ...Otlp.loggers()] : [...Logging.loggers()], {
      mergeWithExisting: false,
    }).pipe(
      Layer.provide(NodeFileSystem.layer),
      Layer.provide(OtlpSerialization.layerJson),
      Layer.provide(
        Layer.effect(
          HttpClient.HttpClient,
          HttpClient.HttpClient.pipe(
            Effect.map((client) =>
              HttpClient.transform(client, (response, request) =>
                response.pipe(
                  Effect.timeoutOrElse({
                    duration: CalloutPolicy.telemetryLogs.timeoutMs,
                    orElse: () =>
                      Effect.fail(
                        new HttpClientError.HttpClientError({
                          reason: new HttpClientError.TransportError({
                            request,
                            description: "Telemetry export timed out",
                          }),
                        }),
                      ),
                  }),
                ),
              ),
            ),
          ),
        ).pipe(Layer.provide(FetchHttpClient.layer)),
      ),
      // ⚠️ NO `Layer.orDie` here, deliberately, and the type is what holds the line: the only
      // failure this composition could ever carry was `Logger.toFile`'s `PlatformError`, and
      // `Logging.fileLoggerOrStderr` now absorbs that into the stderr sink. `OtlpLogger.make`'s
      // error channel is `never`. So this layer's error channel is `never` by construction, and
      // re-adding an `orDie` would be re-arming the boot-killer this line used to be
      // (`notes/reports/startup-classification-2026-08-07.md` §5, finding 2).
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    // The tracing layer is a dynamic import of the OpenTelemetry SDK, so a broken or partial install
    // is a rejected promise — which `Effect.promise` turns into a defect on the boot path. Tracing
    // is the most optional thing in this file; losing it must cost a warning, never the instance.
    const tracing = otlp
      ? yield* Effect.tryPromise(Otlp.tracingLayer).pipe(
          Effect.catchCause((cause) => {
            console.error(
              `[novaclaw] WARNING: OpenTelemetry tracing could not be initialised ` +
                `(${Cause.pretty(cause)}); this run has logs but no traces.`,
            )
            return Effect.succeed(Layer.empty)
          }),
        )
      : Layer.empty
    return Layer.merge(logs, tracing)
  }),
)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })
