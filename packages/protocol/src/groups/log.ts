import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

/**
 * ─── reading the instance's OWN log over HTTP ───────────────────────────────────────────────────
 *
 * The Debug app's Error-log panel shows the RENDERER's ring buffer; the
 * instance writes a separate, keyed, rotated `novaclaw.log` that nothing in the UI could reach.
 * The reason it stayed unreachable was structural rather than effort:
 *
 *   · ruling 11 pins the legacy httpapi surface **shrink-only** (`legacy-path-ledger.test.ts`), so a
 *     read route's only legal home is `/api/*` — this file plus `packages/server/src/handlers/log.ts`.
 *   · `formatLines` lives in `core/src/tool/log.ts` and reaches `log-read.ts` → `node:fs`/`node:zlib`,
 *     so it can never run in a renderer.
 *
 * ── ⭐ the response carries ONE line-bearing field, and that is the design ───────────────────────
 *
 * {@link LogReadResult} has `text` and no `columns`, no `lines[]`, no `raw`. That is deliberate and
 * it is the mechanism, not a simplification: 3f's handover says *"the rendering must happen
 * SERVER-side through `formatLines` and the client must display the string it returns, never
 * re-derive it — a second formatter beside `formatLines` + `LogRead.project` + the class table is
 * exactly the one-description-twice defect."* A wire that carries no structured line **cannot** be
 * re-rendered, so the invariant is not a review note; the response type enforces it.
 *
 * The client half is still free to build a FILTER vocabulary from `@novaclaw/schema/log-events`,
 * which is leaf-clean and safe in a browser bundle — subsystem names, levels, attribute names. What
 * it may not do is re-render a LINE, and it has nothing to re-render one from.
 *
 * ── the plane default is `local`, and it is a ruling rather than a shrug ─────────────────────────
 *
 * `plane: "maintenance"` keeps only columns the class table declares `content: "none"` and renders
 * every other as `name=‹class›`. `plane: "local"` returns the line in full. **The default is
 * `local`**, matching the `log` tool (3g), for three reasons and against one objection worth
 * stating:
 *
 *  1. **It is the user's own machine and their own data.** This surface is the Debug app, which is
 *     Developer-mode only, reading the log of the instance the user is running. A redacted-by-default
 *     read is 3g's *"safe and useless"* — the developer looking at it is looking for the `fault=`.
 *  2. **`maintenance` is a product ACT, not a safety floor** — *"give me something I can send to the
 *     developers"*. Defaulting to it would make the common case pay for the rare one and would train
 *     a reader to ignore `‹user›` placeholders.
 *  3. **Nothing here re-decides a class.** No parameter can widen `maintenance`; the answer was fixed
 *     when the attribute was declared (`ATTRIBUTE_CLASSES`). The precedent this refuses is the
 *     redaction pass that substring-matched key NAMES and failed both ways at once — hiding `monkey`,
 *     exposing `credential`.
 *
 * ⚠️ **The objection, answered rather than ignored: this is HTTP, so the caller may be a REMOTE
 * peer** (AGENTS.md's UI-drives-remote-OS mode). It is still not a widening. The caller holds the
 * instance's own credential — the same one that already streams every session's full message content
 * over `/api/session/*`, which is strictly more user content than a log line. Redacting the log while
 * the chat transcript travels in full would be a false statement about where the boundary is
 * (ruling 2), not a boundary. The boundary is the credential, and it is `Authorization`'s job.
 *
 * ── what it refuses, and every refusal is mechanical ────────────────────────────────────────────
 *
 * A log is the highest-density user content in the product and this is an HTTP surface, so the
 * caller is assumed hostile — the same seriousness `POST /log` needed when its `extra` map turned
 * out to be an `event=` forgery vector (1g).
 *
 *  1. 🔴 **There is no `directory`, `file`, `path` or `name` field, and that is the load-bearing
 *     refusal.** The source is derived from `Global.Path.log` in the handler. A path parameter would
 *     turn a log reader into an authenticated arbitrary-file reader that skips every gate the
 *     filesystem routes answer to. The tool refuses it for the same reason and the stake is higher
 *     here, because a tool call is inside a permission evaluator and an HTTP request is not.
 *  2. **`plane` and `level` are closed literal unions**, so an unknown value is a schema 400 before
 *     the handler runs — there is no string to interpret and no default to fall through to.
 *  3. **An unknown `subsystem` is a 400 that names the declared set**, never a silent empty result.
 *     "No lines match" would be a false description of the instance (ruling 2) and would send a
 *     reader hunting for a fault that never existed.
 *  4. **An unparseable `since` is a 400** that names the accepted durations, for the same reason.
 *  5. **Every filter string is length-capped** ({@link MAX_FILTER_CHARS}). A filter is not a crash
 *     report, so rejecting is right here where truncating was right for `POST /log`'s message.
 *  6. **`limit` is CLAMPED, not rejected** — a limit is a preference about the answer's size rather
 *     than a claim about the instance, and a 400 for asking for 10 000 lines helps nobody. The line
 *     itself is capped by `formatLines`, and the whole walk by `LogRead.SCAN_BYTES` (4 MB newest
 *     first) with a 32 MB ceiling per compressed segment, so one call can never page the 256 MB
 *     retention budget into a response.
 *
 * ⚠️ **Reading a log must never take the instance down** — the rule `log-file.ts` states for the
 * write side, and it binds harder here because this surface is reached *after* something has already
 * failed. Every filesystem call under `LogRead` is total; the handler adds the outer belt.
 */

/** The severity FLOOR. `warn` returns warnings and errors — the wire's four levels, not the renderer's five. */
export const LogLevel = Schema.Literals(["debug", "info", "warn", "error"]).annotate({
  identifier: "LogLevel",
  description: "Minimum severity — a floor, not an exact match. 'warn' returns warnings and errors.",
})

/** Which of AGENTS.md's two planes the caller is asking for. */
export const LogPlane = Schema.Literals(["local", "maintenance"]).annotate({
  identifier: "LogPlane",
  description:
    "'local' (default) renders every column in full — this instance's own log, for repairing it. " +
    "'maintenance' renders every column the class table does not declare content-free as " +
    "`name=<class>`, for a report you send onward. Withheld columns are NAMED, never dropped: a " +
    "silently shorter line is a lie about what the log contains.",
})

/**
 * The longest a single filter value may be. Generous next to any real query (the longest declared
 * event key is well under 60 characters) and small enough that a filter set cannot be a payload.
 */
export const MAX_FILTER_CHARS = 256

export const LogReadRequest = Schema.Struct({
  level: Schema.optional(LogLevel),
  key: Schema.optional(Schema.String).annotate({
    description: "An event key or a dotted prefix of one, e.g. 'session.' or 'mcp.server.spawn.failed'.",
  }),
  subsystem: Schema.optional(Schema.String).annotate({
    description: "One subsystem name — the first segment of a key. An unknown one is a 400 naming the set.",
  }),
  correlator: Schema.optional(Schema.String).annotate({
    description: "An exact id to follow across lines: a session id, a pty id, a workspace id.",
  }),
  match: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive substring anywhere on the line.",
  }),
  since: Schema.optional(Schema.String).annotate({
    description: "Only lines newer than this age: '30m', '4h', '2d'. Anything else is a 400.",
  }),
  limit: Schema.optional(Schema.Finite).annotate({
    description: "Newest matching lines to render. Clamped to the server's ceiling rather than rejected.",
  }),
  plane: Schema.optional(LogPlane),
}).annotate({ identifier: "LogReadRequest" })

export const LogReadResult = Schema.Struct({
  /**
   * ⭐ **The rendered block, and the ONLY field that carries a line.** Produced by
   * `LogTool.formatLines`, which is also what the `log` tool hands a model — one renderer, one
   * per-line cap, one provenance frame. When the block still carries values authored outside this
   * instance (an MCP server's relayed output, a provider's error body inside a `fault=`, a client's
   * own `message` from `POST /log`) it opens with the untrusted-content frame, because a log file is
   * the one local artifact where nothing framed those bytes on the way in.
   */
  text: Schema.String.annotate({
    description:
      "The matching lines, oldest first, already rendered for the requested plane. Display it; do " +
      "not re-derive it — the server owns the one rendering.",
  }),
  lines: Schema.Int.annotate({ description: "How many log lines `text` contains." }),
  /**
   * Lines examined. **`scanned === 0` with `lines === 0` means there is no log file yet**, which is
   * a different fact from "the filter matched nothing" — and only one of the two is about the
   * instance. The empty state a reader is shown depends on this.
   */
  scanned: Schema.Int.annotate({ description: "Lines examined. 0 with no lines means an empty or absent log." }),
  truncated: Schema.Boolean.annotate({
    description: "The scan ceiling stopped the walk, so older history was not examined.",
  }),
  /** Echoed so a rendered block is never read under the wrong plane after a filter changes mid-flight. */
  plane: LogPlane,
}).annotate({ identifier: "LogReadResult" })

export const LogGroup = HttpApiGroup.make("server.log")
  .add(
    // ⚠️ **`POST`, and `/api/log/read` rather than `/api/log`.** Two deliberate choices:
    //
    //  · **POST for a read** because the filters carry USER CONTENT. `correlator` is a session id —
    //    class `correlate`, which 1e ruled may never egress — and `match` is a substring of the
    //    user's own log. A query string is the wrong carrier for either: it lands in access logs,
    //    proxy logs and referrers. `config.remove` is the same shape for the same family of reason,
    //    and no `/api/*` group declares `urlParams` today.
    //  · **`/read` in the path** because 1g wants the WRITE route (`POST /log`, legacy) to move to
    //    `POST /api/log` — that move shrinks ruling 11's ledger by one and is a four-line edit
    //    waiting on `log-events.ts`. Taking the bare path for a read would collide with it.
    HttpApiEndpoint.post("log.read", "/api/log/read", {
      payload: LogReadRequest,
      success: LogReadResult,
      error: InvalidRequestError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.log.read",
        summary: "Read this instance's own log",
        description:
          "Read `novaclaw.log` — the instance's keyed, rotated activity log — filtered and rendered " +
          "server-side. The instance's own log directory is the only source; there is no path " +
          "parameter. The response carries the rendered text and nothing structured, so there is " +
          "exactly one renderer of a log line in the product.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("log.export", "/api/log/export", {
      success: HttpApiSchema.StreamUint8Array({ contentType: "text/plain; charset=utf-8" }),
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.log.export",
        summary: "Stream bounded diagnostics from this instance",
        description:
          "Streams this instance's own recent activity log through the maintenance-plane projection. " +
          "The source is fixed server-side; the request accepts no filesystem path.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "log",
      description: "The instance's own activity log, read-only.",
    }),
  )
