import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const Refusal = Schema.Literals([
  "consent_off",
  "airgap",
  "no_endpoint",
  "content_bearing_event",
  "unknown_event",
  "empty_signature",
])
const Envelope = Schema.Struct({
  signature: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
  attributes: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Finite, Schema.Boolean])),
})

export const TelemetryStatus = Schema.Struct({
  gate: Schema.Struct({ consent: Schema.Boolean, airgap: Schema.Boolean }),
  endpointConfigured: Schema.Boolean,
  ready: Schema.Boolean,
  refusals: Schema.Array(Refusal),
  payloadPreview: Schema.optional(Envelope),
  disclosure: Schema.Array(
    Schema.Struct({
      field: Schema.String,
      class: Schema.String,
      meaning: Schema.String,
      condition: Schema.String,
    }),
  ),
})

export const TelemetryPaths = { status: "/api/telemetry/status" } as const

export const TelemetryGroup = HttpApiGroup.make("server.telemetry")
  .add(
    HttpApiEndpoint.get("telemetry.status", TelemetryPaths.status, {
      success: TelemetryStatus,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.telemetry.status",
        summary: "Crash-reporting status",
        description:
          "Show every live refusal, the exact synthetic payload the sender would produce, and its generated field disclosure.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "telemetry",
      description:
        "The maintenance plane, made inspectable: what crash reporting would send, what is stopping it, and what every field means.",
    }),
  )
