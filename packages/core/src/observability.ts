export * as Observability from "./observability"

import { NodeFileSystem } from "@effect/platform-node"
import { LayerNode } from "./effect/layer-node"
import { Effect, Layer, Logger, References } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpSerialization } from "effect/unstable/observability"
import { Global } from "./global"
import { checkUrl, loadPolicy } from "./offline"
import { Logging } from "./observability/logging"
import { Otlp } from "./observability/otlp"

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
      Layer.provide(FetchHttpClient.layer),
      Layer.orDie,
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    return Layer.merge(logs, otlp ? yield* Effect.promise(Otlp.tracingLayer) : Layer.empty)
  }),
)

export const node = LayerNode.make({ name: "observability", layer, deps: [] })
