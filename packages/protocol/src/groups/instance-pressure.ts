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

/**
 * The LIVE PROCESS FLEET, so a person can localize a leak instead of guessing at the host total.
 *
 * 🔴 **A host total cannot answer "which process grew?"** `/api/instance/pressure` reports one number
 * for the whole machine, and the only memory instrument the product owns (`ProcessCommit`) was never
 * on a route. This is that instrument's read surface: the instance server's own runtime breakdown
 * (the closest thing to a per-module split the JS runtime can honestly give), every live session
 * worker with its session id and measured footprint, and the host reading those sit inside.
 *
 * ⚠️ **The metric rides with every reading.** On Windows `bytes` is COMMIT
 * (`PagedMemorySize64`) and on Linux it is RSS; reporting one number under one name would be a lie in
 * whichever direction the reader guessed. A process that could not be measured is `null`, never `0`.
 */
export const ProcessMemoryEndpoint = HttpApiEndpoint.get("process.memory.get", "/api/memory-layout", {
  success: Schema.Struct({
    measuredAt: Schema.Finite,
    metric: Schema.String,
    host: MemoryReading,
    /** The instance server process, with the JS runtime's own accounting of where its heap went. */
    server: Schema.Struct({
      pid: Schema.Finite,
      rssBytes: Schema.Finite,
      heapTotalBytes: Schema.Finite,
      heapUsedBytes: Schema.Finite,
      externalBytes: Schema.Finite,
      arrayBuffersBytes: Schema.Finite,
      /** The same server pid, read from OUTSIDE it — commit on Windows, RSS on Linux. Null if unknown. */
      bytes: Schema.NullOr(Schema.Finite),
    }),
    processes: Schema.Array(
      Schema.Struct({
        pid: Schema.Finite,
        role: Schema.String,
        /** A chat a person can open, or the role's own name. */
        label: Schema.String,
        startedAt: Schema.NullOr(Schema.Finite),
        bytes: Schema.NullOr(Schema.Finite),
      }),
    ),
    note: Schema.String,
  }),
}).annotateMerge(
  OpenApi.annotations({
    identifier: "v2.process.memory.get",
    summary: "Get the process memory layout",
    description:
      "Per-process memory for the instance server and its live session workers, plus the server runtime's heap breakdown. Read from outside each process; commit on Windows, RSS on Linux.",
  }),
)
