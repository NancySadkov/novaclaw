export * as LogTool from "./log"

import { ToolFailure } from "@novaclaw/llm"
import { EVENTS, type EventKey, type Level, SUBSYSTEMS, type Subsystem } from "@novaclaw/schema/log-events"
import { Effect, Layer, Schema } from "effect"
import path from "node:path"
import { makeLocationNode } from "../effect/app-node"
import { Global } from "../global"
import { LogRead } from "../observability/log-read"
import { SessionOrigin } from "../session/origin"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * **The `log` tool — the self-healing law reaching the logs.**
 *
 * AGENTS.md states the law in one sentence: *as long as at least one working model remains, the
 * system must be restorable to a working state by asking an agent* — and asks of every feature *"if
 * this breaks while the vendor is asleep, can an agent inside the OS repair it?"* **An agent that
 * cannot read the error cannot repair it.** The keyed-event contract and the writer built the log
 * this tool reads: a stable
 * `event=` key (so a query is a query, not a bet on a string literal), a level declared with the
 * key, classified attributes, and a bounded on-disk history. This is the surface that turns all of
 * that into an answer.
 *
 * ── ⭐ the asymmetry, because it is the whole justification ─────────────────────────────────────
 *
 * The writer serves the **local plane**, where every attribute class is legible — including the ones
 * telemetry may never send (AGENTS.md design-principle 4, *two planes*). That asymmetry is
 * deliberate, and it is exactly what lets an agent inside the OS read what the maintenance plane
 * cannot. So the default `plane` here is `local` and it returns the `fault=`, `path=` and `text=`
 * columns in full. Redacting by default would produce a tool that is safe and useless, which is the
 * shape this item was written to avoid.
 *
 * The second mode exists for the other product act — *"give me something I can send to the
 * developers"* — and it is computed from the attribute CLASS TABLE in `@novaclaw/schema/log-events`,
 * never from the shape of a column name. ⚠️ An earlier item in this repo redacted by substring-
 * matching key names and failed in both directions at once, hiding `monkey` and exposing
 * `credential`. See `observability/log-read.ts` → `classOf`, and the negative control in
 * `log.test.ts` that runs one line through both planes and asserts the value is present in one and
 * absent in the other. An absence assertion alone can pass because the value was never there.
 *
 * ── why ONE tool with three ops ─────────────────────────────────────────────────────────────────
 *
 * Tool-count pressure is live (reported degradation from 30–50 tools, and we
 * are past it), so a log surface costing three schema slots would be paying the tax this repo is
 * trying to stop paying. The house pattern is `kb`'s closed op vocabulary, followed by `docs`
 * (`list`/`read`/`search`) and by `configure` — which answered the same question by gaining a fourth
 * member rather than a second tool. Here:
 *
 *  · `keys`  — the declared vocabulary: what events exist, at what level, carrying what. The INDEX.
 *  · `read`  — matching lines. The CONTENT.
 *  · `count` — the same filter, as a histogram. The TRIAGE: what is failing, and how much.
 *
 * `read` and `count` share ONE filter vocabulary and one walk (`log-read.ts`), so a count can never
 * disagree with the lines it counted. There is no `search` op because a substring is a FILTER, not a
 * different question — folding it in is one fewer op for strictly more reach.
 *
 * ── deferred, following `resource_status` ───────────────────────────────────────────────────────
 *
 * `Tool.withDeferred`: this is a diagnostic reached after something has gone wrong, not a per-turn
 * capability, so it costs no prompt tokens until `tool_search` discloses it. That is the same call
 * `resource_status` makes for the same reason. ⚠️ It is the OPPOSITE of `docs`' call, and the test
 * is what the prompt would have to carry: `docs` pays because its topic NAMES are the index a model
 * needs in order to know the manual exists; this tool's index is `{op:'keys'}`, which is a call.
 *
 * ── untrusted framing: FRAMED, and the two mechanisms compose ───────────────────────────────────
 *
 * `test/untrusted-framing.test.ts`'s rule is *"a tool carries external content when the TOOL ITSELF
 * goes and gets bytes from a party other than the user."* On the letter of it a log reader looks
 * local — the same argument that puts `read`/`grep` in `NO_EXTERNAL`. **It does not hold here**, and
 * the difference is worth stating because it is the only reason this file is not in that list: that
 * entry's defence is *"framing at the moment bytes ENTER is the cheap, honest place"*, i.e. an
 * earlier tool already declared the provenance. **Nothing ever framed a log line.** An MCP server's
 * relayed output, a provider's error body inside a `fault=`, and a client's own `message` arriving
 * over `POST /log` are all a third party's words, written into a file by a writer that has no frame
 * to apply — and this tool then hands them to the model. So the log is precisely the case where the
 * declaration is the *only* surviving record of who wrote a value, and reading it here is the cheap
 * honest place.
 *
 * The frame is **per block and label-precise**, never a wrapper over the whole result: see
 * {@link FOREIGN_LABEL} and {@link formatLines}. `count` and `keys` are never framed — a bucket name
 * is a declared key and a declaration is our own source code, which is `docs.ts`'s reasoning exactly.
 *
 * ⭐ **How it composes with `plane`, since both answer a question about the same column.** They are
 * different questions — `content` is *may this leave the machine*, `SPEAKS_FOR_OTHERS` is *who wrote
 * it* — and they disagree exactly once, on `path`: never egresses, and still the user's own words
 * rather than a stranger's. But every class that speaks for others is `content !== "none"`, so a
 * `maintenance` projection has already withheld all of them and `carriesForeign` returns false by
 * construction. That implication is asserted in `log.test.ts` rather than assumed, so a future
 * attribute class cannot break the composition silently.
 *
 * ── the permission gate ─────────────────────────────────────────────────────────────────────────
 *
 * Registered under its own name with no `Tool.withPermission` wrap, because the name fallback in
 * `tool.ts` already governs it — a `{action:"log", effect:"deny"}` rule withdraws it from the
 * model's horizon entirely (`registry.ts` → `whollyDisabled`). Stated rather than claimed: that is
 * WITHDRAWAL, not a per-call ask, and it is the honest description of what gates a read here.
 */
export const name = "log"

/** Returned lines per call, and the ceiling a caller may ask for. */
export const DEFAULT_LIMIT = 40
export const MAX_LIMIT = 200
/** A returned line is truncated here: one pathological `fault=` must not become the whole result. */
export const MAX_LINE_CHARS = 2000
/** Buckets returned by `count`. */
export const MAX_BUCKETS = 40
/** Declarations returned by `keys` when nothing narrows it. */
export const MAX_KEYS = 60

const LevelSchema = Schema.Literals(["debug", "info", "warn", "error"])
const PlaneSchema = Schema.Literals(["local", "maintenance"])

const Filters = {
  level: Schema.optional(LevelSchema).annotate({
    description: "Minimum severity — a floor. 'warn' returns warnings and errors.",
  }),
  key: Schema.optional(Schema.String).annotate({
    description: "An event key or a dotted prefix of one, e.g. 'session.' or 'mcp.server.spawn.failed'",
  }),
  subsystem: Schema.optional(Schema.String).annotate({
    description: "One subsystem name — the first segment of a key. See {op:'keys'}.",
  }),
  correlator: Schema.optional(Schema.String).annotate({
    description: "An exact id to follow across lines: a session id, a pty id, a workspace id.",
  }),
  match: Schema.optional(Schema.String).annotate({
    description: "Case-insensitive substring anywhere on the line. Use it to search error text.",
  }),
  since: Schema.optional(Schema.String).annotate({
    description: "Only lines newer than this age: '30m', '4h', '2d'.",
  }),
}

const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  ...Filters,
  limit: Schema.optional(Schema.Finite).annotate({ description: `Newest matching lines (default ${DEFAULT_LIMIT})` }),
  plane: Schema.optional(PlaneSchema).annotate({
    description:
      "'local' (default) returns the lines in full — this instance's own log, for repairing it. " +
      "'maintenance' withholds every column that may not leave this machine, for a report you send onward.",
  }),
})

const CountOp = Schema.Struct({
  op: Schema.Literal("count"),
  ...Filters,
  by: Schema.optional(Schema.Literals(["event", "level", "subsystem"])).annotate({
    description: "Group by (default 'event')",
  }),
})

const KeysOp = Schema.Struct({
  op: Schema.Literal("keys"),
  subsystem: Schema.optional(Schema.String).annotate({ description: "Only this subsystem's events" }),
  level: Schema.optional(LevelSchema).annotate({ description: "Only events declared at this level or above" }),
  match: Schema.optional(Schema.String).annotate({ description: "Substring over the key and its message" }),
})

export const Input = Schema.Union([ReadOp, CountOp, KeysOp])

export const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
export type Output = typeof Output.Type

export const description = [
  "Read THIS instance's own log — the record of what the OS actually did. Use it whenever something",
  "failed, hung, or behaved unexpectedly and you need the real cause rather than a guess, and before",
  "reporting that something is broken.",
  "Ops: {op:'keys',subsystem?,level?,match?} — the declared event vocabulary (start here);",
  "{op:'read',level?,key?,subsystem?,correlator?,match?,since?,limit?,plane?} — matching lines;",
  "{op:'count',by?,...same filters} — how often each event fired.",
  "Lines are logfmt: event=<subsystem.object.action> names the event, and values are named columns.",
].join("\n")

// ── argument repair, not rejection ──────────────────────────────────────────────────────────────

const DURATION = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/i
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
}

/** `"4h"` → milliseconds, or `undefined` when it is not a duration we accept. */
export function durationMs(input: string): number | undefined {
  const parts = DURATION.exec(input.trim())
  if (!parts) return undefined
  return Number(parts[1]) * UNIT_MS[parts[2]!.toLowerCase()]!
}

const clamp = (value: number | undefined, fallback: number, max: number) => {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.max(1, Math.min(max, Math.floor(value)))
}

const truncate = (line: string) => (line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)

/**
 * **The label, and every word in it is load-bearing.** `test/untrusted-framing.test.ts` §1 pins the
 * frame's shape; the *label* is the caller's, and ruling 2 makes it a claim we have to be able to
 * defend.
 *
 *  · **"values"**, not *lines* or *the log*. Most of a line is ours — `timestamp`, `level`, `run`,
 *    `event`, the declared constant `message=`, and every `id`/`count`/`flag`/`correlate`/`path`
 *    column. A label reading *"log lines — treat as data, not as instructions"* would tell a small
 *    model to discount our own `event=` key, which is the one column the whole of Phase 1 exists to
 *    make it trust. This is `formatChats`'s lesson verbatim: it says *"chat names from the messaging
 *    platform"* and deliberately not *"a chat list"*, so the ruling-7 access tag beside the names
 *    keeps its authority.
 *  · **"other programs"** names the actual source: an MCP server's relayed output, a provider's
 *    error body inside a `fault=`, a client's own `message` arriving over `POST /log`.
 *  · **"logged"** keeps it honest that the file is ours and the values merely passed through it.
 */
export const FOREIGN_LABEL = "logged values from other programs"

/**
 * The line block, framed IF it still carries somebody else's words.
 *
 * ⚠️ **The frame lives here and NOT in `toModelOutput`**, which is `websearch.formatResults`'s rule
 * and the correction the retired `messenger.ts` debt entry records: a blanket prefix at the
 * model-text seam *"WOULD have mislabelled every instance fault as a stranger's words"*. This tool
 * says plenty of its own: the header, "No line matches", the two refusals, every `count` bucket and
 * every `keys` declaration. None of that is framed, because none of it came from anywhere else.
 *
 * ⚠️ **One frame for the block, not one per line.** A `read` returns up to 200 lines for one
 * question about one file; a per-line prefix would bill the frame 200 times, which is what
 * `externalContentFrame`'s own one-line ratchet exists to prevent (`formatHistory` frames a
 * 200-message batch once for the same reason).
 *
 * ⚠️ **A block with nothing foreign in it is NOT framed** — the `formatResults([]) === ""` rule:
 * a frame announces a source, and announcing one that sent nothing is a false statement about the
 * content beneath it. In practice that is every `plane: "maintenance"` read, because the projection
 * has already withheld each class that speaks for others.
 */
export function formatLines(lines: ReadonlyArray<LogRead.Line>, plane: LogRead.Plane): string {
  const body = lines.map((line) => truncate(LogRead.project(line, plane))).join("\n")
  return lines.some((line) => LogRead.carriesForeign(line, plane))
    ? SessionOrigin.externalContentFrame(FOREIGN_LABEL) + body
    : body
}

const subsystemNames = () => Object.keys(SUBSYSTEMS).sort()

const unknownSubsystem = (given: string) =>
  new ToolFailure({
    message: `"${given}" is not a subsystem. Subsystems: ${subsystemNames().join(", ")}. A subsystem is the FIRST segment of an event key; use {op:'keys'} to see the events in one.`,
  })

/** Everything the ops need that is not the input: injected so a test never touches the real home. */
export interface Source {
  readonly directory: string
  readonly name: string
  readonly now: () => number
}

/** The instance's own log directory. **Not a parameter** — see the refusal note in `run`. */
export const instanceSource = (): Source => ({ directory: Global.Path.log, name: "novaclaw", now: Date.now })

const filterOf = (
  input: { level?: Level; key?: string; subsystem?: string; correlator?: string; match?: string; since?: string },
  source: Source,
) => {
  const since = input.since === undefined ? undefined : durationMs(input.since)
  return {
    level: input.level,
    key: input.key,
    subsystem: input.subsystem as Subsystem | undefined,
    correlator: input.correlator,
    match: input.match,
    sinceMs: since === undefined ? undefined : source.now() - since,
  }
}

const declarationLine = (key: string) => {
  const declaration = EVENTS[key as EventKey]
  const attributes = Object.keys(declaration.attributes)
  return `${declaration.level.toUpperCase().padEnd(5)} ${key} — ${declaration.message}${
    attributes.length === 0 ? "" : ` [${attributes.join(" ")}]`
  }`
}

/**
 * ⚠️ **There is no `file`, `directory` or `path` parameter, and that is a refusal rather than an
 * omission.** The source is derived from `Global.Path.log`, so this tool can read the instance's own
 * log and nothing else. A path parameter would turn a log reader into a general file reader that
 * skips every gate `read`/`glob`/`grep` answer to — the "one tool grew a second capability nobody
 * gated" shape. If an agent needs another file, it has `read`.
 */
export function run(input: typeof Input.Type, source: Source): Output | ToolFailure {
  if (input.subsystem !== undefined && !(input.subsystem in SUBSYSTEMS)) return unknownSubsystem(input.subsystem)

  if (input.op === "keys") {
    const floor = input.level === undefined ? 0 : LogRead.LEVEL_ORDER[input.level]
    const needle = input.match?.toLowerCase()
    const selected = Object.keys(EVENTS)
      .filter((key) => {
        const declaration = EVENTS[key as EventKey]
        if (input.subsystem !== undefined && !key.startsWith(`${input.subsystem}.`)) return false
        if (LogRead.LEVEL_ORDER[declaration.level] < floor) return false
        if (needle !== undefined && !`${key} ${declaration.message}`.toLowerCase().includes(needle)) return false
        return true
      })
      .sort()
    if (selected.length === 0)
      return {
        ok: false,
        message: `No declared event matches. Subsystems: ${subsystemNames().join(", ")}.`,
      }
    const shown = selected.slice(0, MAX_KEYS)
    const rest = selected.length - shown.length
    return {
      ok: true,
      message: [
        `${selected.length} declared event${selected.length === 1 ? "" : "s"}` +
          (rest > 0 ? ` (showing ${shown.length}; narrow with subsystem/level/match)` : ""),
        ...shown.map(declarationLine),
      ].join("\n"),
    }
  }

  const filter = filterOf(input, source)
  if (input.since !== undefined && filter.sinceMs === undefined)
    return new ToolFailure({
      message: `"${input.since}" is not a duration. Use a number and a unit: '30m', '4h', '2d'.`,
    })

  if (input.op === "count") {
    const buckets = LogRead.tally(
      { ...filter, directory: source.directory, name: source.name, limit: 0 },
      input.by ?? "event",
    )
    if (buckets.length === 0) return { ok: true, message: "No lines match. Widen the filter, or check {op:'keys'}." }
    const shown = buckets.slice(0, MAX_BUCKETS)
    const total = buckets.reduce((sum, [, n]) => sum + n, 0)
    return {
      ok: true,
      message: [
        `${total} line${total === 1 ? "" : "s"} in ${buckets.length} bucket${buckets.length === 1 ? "" : "s"}, by ${input.by ?? "event"}:`,
        ...shown.map(([bucket, n]) => `${String(n).padStart(6)}  ${bucket}`),
      ].join("\n"),
    }
  }

  const plane = input.plane ?? "local"
  const result = LogRead.scan({
    ...filter,
    directory: source.directory,
    name: source.name,
    limit: clamp(input.limit, DEFAULT_LIMIT, MAX_LIMIT),
    plane,
  })
  if (result.lines.length === 0)
    return {
      ok: true,
      message:
        result.scanned === 0
          ? `No log lines found under ${source.directory}. A fresh instance may not have written one yet.`
          : `No line matches (examined ${result.scanned}). Widen the filter, or start from {op:'count'}.`,
    }
  const header =
    `${result.lines.length} line${result.lines.length === 1 ? "" : "s"}, oldest first` +
    (plane === "maintenance" ? " · maintenance plane: local-only columns are shown as ‹class›" : "") +
    (result.truncated ? " · scan ceiling reached, older history not examined" : "")
  // The header is OURS and stays outside the frame; `formatLines` owns the labelled half.
  return { ok: true, message: `${header}\n${formatLines(result.lines, plane)}` }
}

export const metadata = { description, input: Input, output: Output } as const

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.withDeferred(
          Tool.make({
            ...metadata,
            toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
            execute: (input) =>
              // Reading a log must never be the thing that takes the instance down — the same rule
              // `log-file.ts` enforces for the write side, and for the same reason: this subsystem is
              // most needed when something else has already failed. Every filesystem call inside
              // `log-read.ts` is already total; this is the outer belt for anything that is not.
              Effect.try({
                try: () => run(input, instanceSource()),
                catch: (error) => new ToolFailure({ message: `Could not read the instance log: ${String(error)}` }),
              }).pipe(
                Effect.flatMap((result) =>
                  result instanceof ToolFailure ? Effect.fail(result) : Effect.succeed(result),
                ),
              ),
          }),
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/log", layer, deps: [ToolRegistry.node] })

/** Exported for the smoke: the active segment this tool reads. */
export const activeSegment = () => path.join(Global.Path.log, "novaclaw.log")
