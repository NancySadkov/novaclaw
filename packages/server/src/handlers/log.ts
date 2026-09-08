import { LogRead } from "@novaclaw/core/observability/log-read"
import { LogTool } from "@novaclaw/core/tool/log"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { MAX_FILTER_CHARS } from "@novaclaw/protocol/groups/log"
import { SUBSYSTEMS, type Subsystem } from "@novaclaw/schema/log-events"
import { Effect, Stream } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { LogApi, handlerLayer } from "../handler-api"

/**
 * **`POST /api/log/read` — the server half of the Debug app's log panel.**
 *
 * The contract, the plane ruling and every refusal are argued in
 * `packages/protocol/src/groups/log.ts`; this file is the wiring plus the three 400s a schema cannot
 * express on its own.
 *
 * ⭐ **What this handler deliberately does NOT contain: a renderer.** It refuses, it filters, it
 * walks, and it calls `LogTool.formatLines` — the same function the `log` tool hands a model. There
 * is one projection (`LogRead.project`), one per-line cap (`LogTool.MAX_LINE_CHARS`) and one
 * provenance frame in the product, and this route reuses all three rather than growing a second set
 * beside them. 3f's handover names a second formatter as the *one description existing twice* defect
 * this repo has found ~a dozen times; the response type (`text`, and nothing structured) is what
 * makes the second one unbuildable rather than merely discouraged.
 *
 * ⚠️ **There is no outer try/catch, and that is a decision rather than an omission.**
 * `LogRead.scan` is total by construction: `readSegment` wraps every `stat`/`open`/`read`/`gunzip`
 * in a `try` and answers `""`, `segmentsIn` answers `[]` on an unreadable directory, and `parse`,
 * `matches` and `project` are pure. So a belt here would catch nothing while forcing this file to
 * invent a failure vocabulary for a case that cannot arrive — and `log-file.ts` already records
 * what a `catch` around housekeeping costs: *it will also swallow the evidence that housekeeping
 * failed.* If something below this line ever does throw it is a defect, and a defect on a read
 * route becomes a 500 through the existing error middleware. That is an honest report, not a fatal
 * path: nothing here dies, and nothing here re-arms the `Layer.orDie` the Observability channel had
 * deleted so the type could hold the channel empty.
 */

/** `InvalidRequestError.kind` values, so a client branches on the fault instead of parsing prose. */
export const LOG_UNKNOWN_SUBSYSTEM_KIND = "log-unknown-subsystem"
export const LOG_BAD_DURATION_KIND = "log-bad-duration"
export const LOG_FILTER_TOO_LONG_KIND = "log-filter-too-long"

const DIAGNOSTIC_CHUNK_BYTES = 64 * 1024

/**
 * The sendable projection used by the diagnostic export. It deliberately delegates the scan,
 * line ceiling and class-table redaction to the same reader as the Debug panel.
 */
export function diagnosticArchive(source: LogTool.Source) {
  const result = read({ plane: "maintenance", since: "1d", limit: LogTool.MAX_LIMIT }, source)
  const bytes = new TextEncoder().encode(
    [
      "# NovaClaw instance diagnostics",
      "# projection=maintenance source=instance-log window=1d",
      `# lines=${result.lines} scanned=${result.scanned} truncated=${result.truncated}`,
      result.text,
    ].join("\n"),
  )
  const chunks: Uint8Array[] = []
  for (let offset = 0; offset < bytes.length; offset += DIAGNOSTIC_CHUNK_BYTES)
    chunks.push(bytes.subarray(offset, offset + DIAGNOSTIC_CHUNK_BYTES))
  return Stream.fromIterable(chunks)
}

const subsystemNames = () => Object.keys(SUBSYSTEMS).sort().join(", ")

/**
 * The filter fields whose LENGTH a caller controls. `level` and `plane` are absent because they are
 * closed literal unions the schema already refused an unknown value for, and `limit` because it is
 * clamped rather than rejected.
 */
const BOUNDED_FIELDS = ["key", "subsystem", "correlator", "match", "since"] as const

/**
 * Everything the schema could not say, in the order a caller would hit it.
 *
 * ⚠️ **Each of these is a 400 rather than an empty result, and that is ruling 2.** A misspelled
 * subsystem answering *"no lines match"* describes the instance as quiet when what actually happened
 * is that the reader asked a question with no referent — and the reader then goes looking for the
 * fault somewhere else. Every message names the repair, because a diagnostic surface that refuses
 * without saying how is one more thing to debug.
 *
 * ⚠️ **A length cap REJECTS here where `POST /log` TRUNCATES**, and the asymmetry is deliberate. A
 * client's log message arrives during a crash, so a truncated crash report beats a 400; a filter is
 * a question asked by something that is still running, and silently answering a different question
 * than the one asked is the worse failure.
 */
export function refuse(payload: {
  readonly key?: string
  readonly subsystem?: string
  readonly correlator?: string
  readonly match?: string
  readonly since?: string
}): InvalidRequestError | undefined {
  for (const field of BOUNDED_FIELDS) {
    const value = payload[field]
    if (value !== undefined && value.length > MAX_FILTER_CHARS)
      return new InvalidRequestError({
        kind: LOG_FILTER_TOO_LONG_KIND,
        field,
        message: `"${field}" is ${value.length} characters; the limit is ${MAX_FILTER_CHARS}. A filter is not a payload.`,
      })
  }
  if (payload.subsystem !== undefined && !(payload.subsystem in SUBSYSTEMS))
    return new InvalidRequestError({
      kind: LOG_UNKNOWN_SUBSYSTEM_KIND,
      field: "subsystem",
      message: `"${payload.subsystem}" is not a subsystem. A subsystem is the FIRST segment of an event key. Subsystems: ${subsystemNames()}.`,
    })
  if (payload.since !== undefined && LogTool.durationMs(payload.since) === undefined)
    return new InvalidRequestError({
      kind: LOG_BAD_DURATION_KIND,
      field: "since",
      message: `"${payload.since}" is not a duration. Use a number and a unit: '30m', '4h', '2d'.`,
    })
  return undefined
}

/** `[1, MAX_LIMIT]`, defaulting when absent or not a number. A limit is a preference, so it bends. */
export const clampLimit = (limit: number | undefined) => {
  if (limit === undefined || !Number.isFinite(limit)) return LogTool.DEFAULT_LIMIT
  return Math.max(1, Math.min(LogTool.MAX_LIMIT, Math.floor(limit)))
}

/**
 * The whole read, separated from the HTTP shell so a test can drive it against a fixture directory
 * without a socket — and so the one thing a test must not be able to do (name a directory) stays
 * impossible from the WIRE while remaining injectable in-process.
 */
export function read(
  payload: {
    readonly level?: "debug" | "info" | "warn" | "error"
    readonly key?: string
    readonly subsystem?: string
    readonly correlator?: string
    readonly match?: string
    readonly since?: string
    readonly limit?: number
    readonly plane?: LogRead.Plane
  },
  source: LogTool.Source,
) {
  const plane = payload.plane ?? "local"
  const since = payload.since === undefined ? undefined : LogTool.durationMs(payload.since)
  const result = LogRead.scan({
    level: payload.level,
    key: payload.key,
    subsystem: payload.subsystem as Subsystem | undefined,
    correlator: payload.correlator,
    match: payload.match,
    sinceMs: since === undefined ? undefined : source.now() - since,
    directory: source.directory,
    name: source.name,
    limit: clampLimit(payload.limit),
    plane,
  })
  return {
    // The ONE rendering. An empty result is an EMPTY STRING, never a sentence: which sentence a
    // reader shows depends on `scanned`, and only the reader knows whether it is a panel, a bug
    // report or a paste into a chat.
    text: LogTool.formatLines(result.lines, plane),
    lines: result.lines.length,
    scanned: result.scanned,
    truncated: result.truncated,
    plane,
  }
}

export const LogHandler = handlerLayer(
  HttpApiBuilder.group(LogApi, "server.log", (handlers) =>
    handlers
      .handle(
        "log.read",
        Effect.fn(function* (ctx) {
          const refusal = refuse(ctx.payload)
          if (refusal !== undefined) return yield* refusal
          // 🔴 **The source is DERIVED, never received.** `instanceSource()` reads `Global.Path.log`, and
          // the request carries no field that could name another directory. Reusing the tool's own
          // accessor rather than rebuilding the path keeps one answer to *"where does this instance's log
          // live"*.
          return read(ctx.payload, LogTool.instanceSource())
        }),
      )
      .handle("log.export", () => Effect.succeed(diagnosticArchive(LogTool.instanceSource()))),
  ),
)
