import { Schema } from "effect"
import { HttpApiEndpoint, OpenApi } from "effect/unstable/httpapi"

export const MemoryReading = Schema.Union([
  Schema.Struct({
    known: Schema.Literal(true),
    source: Schema.String,
    crosscheck: Schema.String,
    usedBytes: Schema.Finite,
    limitBytes: Schema.Finite,
  }),
  Schema.Struct({ known: Schema.Literal(false), reason: Schema.String }),
])

/** The host binds this contract alongside its instance services; no location is needed. */
export const InstancePressureEndpoint = HttpApiEndpoint.get("instance.pressure.get", "/api/instance/pressure", {
  success: Schema.Struct({
    measuredAt: Schema.Finite,
    memory: MemoryReading,
    /** The worst verdict across memory and instance volumes. */
    level: Schema.String,
    /** The memory-only verdict used by the launcher. */
    memoryLevel: Schema.String,
  }),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "v2.instance.pressure.get",
    summary: "Get instance pressure",
    description: "Report cheap host memory pressure without recursive storage accounting.",
  }),
)
