export * as LogRead from "./log-read"

import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import {
  ATTRIBUTE_CLASSES,
  type AttributeClass,
  type ContentClass,
  EVENTS,
  type EventKey,
  type Level,
  type Subsystem,
} from "@novaclaw/schema/log-events"
import { LogFile } from "./log-file"

/**
 * **The READER half of the log — the counterpart to `log-file.ts`, and the thing that makes the
 * self-healing law reach the logs.**
 *
 * The writer (`log-file.ts`) already exports `segmentsIn` and calls itself
 * *"the READER's half of the filename grammar"*; this module is the reader that grammar was for. It
 * is deliberately a separate file and not a method on `Writer`: reading must work when nothing is
 * writing — a crashed instance, a `serve` that died at boot, a segment written by yesterday's run —
 * so the reader may not need a live writer to exist.
 *
 * ── why this exists at all ──────────────────────────────────────────────────────────────────────
 *
 * AGENTS.md: *"as long as at least one working model remains, the system must be restorable to a
 * working state by asking an agent."* An agent that cannot read the error cannot repair it. The
 * whole of Phase 1 (a stable `event=` key, declared levels, classified attributes) exists so that
 * this read is a QUERY rather than a grep against an English sentence somebody may reword.
 *
 * ── ⭐ the asymmetry this module is built around ────────────────────────────────────────────────
 *
 * The file serves the **local plane**, where every attribute class is legible — including the ones
 * telemetry may never send. That is deliberate (AGENTS.md design-principle 4): it is exactly what
 * lets an agent inside the OS read what the maintenance plane cannot. So {@link project} has two
 * modes and the DEFAULT is the permissive one, because a redacted `fault=` column is a log an agent
 * cannot repair from.
 *
 * The restrictive mode is not the safety default — it is a distinct product act: *"give me
 * something I can send to the developers."* Both are computed from `ATTRIBUTE_CLASSES` in
 * `@novaclaw/schema/log-events`, never from the shape of a column NAME. ⚠️ A previous item in this
 * repo redacted by substring-matching key names and it failed in both directions at once, hiding
 * `monkey` and exposing `credential`. A class table cannot do that: the answer was decided when the
 * attribute was declared.
 */

// ── the filename grammar, from the reader's side ────────────────────────────────────────────────

/**
 * How many bytes of history one call may touch, newest first.
 *
 * ⚠️ **This is a bound on the READ, not on the answer**, and it is the reason a `log` call cannot
 * become a denial of service against the instance it is diagnosing. The retention budget is 256 MB
 * (`log-file.ts`) and a naive "scan everything" reader would page all of it into a tool result's
 * process. Newest-first means the cheap answer — *what just broke* — is also the one that never
 * reaches this ceiling.
 */
export const SCAN_BYTES = 4 * 1024 * 1024
/** A rotated segment larger than this compressed is not ours to inflate. */
export const MAX_SEGMENT_GZ_BYTES = 32 * 1024 * 1024

/** Every segment that could hold lines, NEWEST FIRST — the active file, then rotated descending. */
export function sources(directory: string, name: string): ReadonlyArray<string> {
  const active = path.join(directory, `${name}.log`)
  const rotated = LogFile.segmentsIn(directory, name)
    .slice()
    .reverse()
    .map((segment) => segment.file)
  return fs.existsSync(active) ? [active, ...rotated] : rotated
}

/**
 * Read one segment as text, never throwing. An unreadable segment is an empty string: a reader that
 * dies on one corrupt file answers nothing about the twenty good ones beside it, and this module's
 * whole job is to be available when things are already broken.
 *
 * The active segment is read from its TAIL when it is larger than `budget`, because the newest lines
 * are the ones a repair loop wants and the first partial line is dropped rather than mis-parsed.
 */
export function readSegment(file: string, budget: number): string {
  try {
    if (file.endsWith(".gz")) {
      if (fs.statSync(file).size > MAX_SEGMENT_GZ_BYTES) return ""
      return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8")
    }
    const size = fs.statSync(file).size
    if (size <= budget) return fs.readFileSync(file, "utf8")
    const handle = fs.openSync(file, "r")
    try {
      const buffer = Buffer.allocUnsafe(budget)
      fs.readSync(handle, buffer, 0, budget, size - budget)
      const text = buffer.toString("utf8")
      const newline = text.indexOf("\n")
      return newline === -1 ? "" : text.slice(newline + 1)
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ""
  }
}

// ── how fast the log actually grows ─────────────────────────────────────────────────────────────

/**
 * **The measurement the defaults table was missing.**
 *
 * `log-file.ts`'s `SEGMENT_BYTES` / `TOTAL_BYTES` / `MAX_AGE_MS` (8 MB · 256 MB · 30 d) shipped
 * with an explicit confession: *"every one of these is a guess dressed in a
 * measurement"*, to be re-derived once bytes-written-per-hour was emitted as an event. The
 * measurement it names is **27 days of one developer's usage on one machine at INFO** — and it moved
 * 2× (69.5 → 134 KB/day) within nine days of being taken, which is the whole argument for making the
 * instance measure itself instead of inheriting a number.
 *
 * ⚠️ **The rate is measured over the ACTIVE segment only, and that is deliberate rather than lazy.**
 * A rotated segment's stamp is when it was SEALED, so lines inside it are older than their own
 * filename — using it as a history start understates the span and therefore OVERSTATES the rate,
 * and the only way to get the true start is to gunzip the oldest segment at boot. The active
 * segment needs neither: it is plain text, its first line carries a `timestamp=`, and reading 8 KB
 * off the front of one file is the cheapest honest answer available. {@link Usage.spanHours} ships
 * beside the rate for exactly that reason — **a rate over four minutes is not a rate**, and a reader
 * that cannot see the span cannot know that.
 *
 * ⚠️ **`bytesPerHour` is the RAW rate, before gzip.** Retained history is compressed at ~16× on this
 * corpus (§0.5), so anyone converting this into "days until the budget fills" must apply that
 * themselves — and must apply the ratio they measured, not this one. The derivation is deliberately
 * NOT stored here: two places computing one number is the ruling-6 shape.
 */
export interface Usage {
  /** Bytes the whole log directory occupies right now — active segment plus every rotated one. */
  readonly bytes: number
  /** The active segment's own size. */
  readonly activeBytes: number
  /** Rotated segments present (`.log.gz`, and any `.log` whose compression never finished). */
  readonly segments: number
  /** How long the ACTIVE segment has been accumulating, from its first line's `timestamp=`. */
  readonly spanHours?: number
  /** Measured write rate, raw bytes per hour. Absent when the span is too short to mean anything. */
  readonly bytesPerHour?: number
}

/**
 * A span shorter than this makes a rate meaningless — a freshly rotated segment would otherwise
 * report megabytes per hour off ten seconds of boot chatter. Absent is a better answer than a lie.
 */
export const MIN_RATE_SPAN_MS = 10 * 60 * 1000

/**
 * The first line's instant in a plain-text segment.
 *
 * ⚠️ **Re-exported from the WRITER, not re-implemented here.** `log-file.ts` needs the same answer
 * for age-driven rotation, and it cannot import this module (a cycle), so the one body lives there
 * and this is a name for it. Two copies of "what instant does this segment start at" is the
 * one-description-twice defect, and this pair would have drifted in the worst way: the reader would
 * report a rate the writer's rotation did not agree with.
 */
export const firstLineTime = LogFile.firstLineTime

/** Measure the log directory. Never throws — an unreadable directory reports zeroes. */
export function usage(directory: string, name: string, nowMs: number = Date.now()): Usage {
  const active = path.join(directory, `${name}.log`)
  let activeBytes = 0
  try {
    activeBytes = fs.statSync(active).size
  } catch {
    activeBytes = 0
  }
  const rotated = LogFile.segmentsIn(directory, name)
  const bytes = rotated.reduce((sum, segment) => sum + segment.bytes, 0) + activeBytes
  const since = firstLineTime(active)
  const spanMs = since === undefined ? undefined : nowMs - since
  const usable = spanMs !== undefined && spanMs >= MIN_RATE_SPAN_MS
  return {
    bytes,
    activeBytes,
    segments: rotated.length,
    ...(spanMs === undefined || spanMs < 0 ? {} : { spanHours: round(spanMs / 3_600_000) }),
    ...(usable ? { bytesPerHour: Math.round(activeBytes / (spanMs / 3_600_000)) } : {}),
  }
}

const round = (value: number) => Math.round(value * 100) / 100

// ── one line ────────────────────────────────────────────────────────────────────────────────────

/** One parsed logfmt record. `columns` keeps ORDER and DUPLICATES — see {@link parse}. */
export interface Line {
  readonly raw: string
  readonly columns: ReadonlyArray<readonly [string, string]>
  readonly time?: number
  readonly level?: string
  readonly event?: string
}

/**
 * Parse one logfmt line the way `observability/logging.ts` writes it: `key=value`, space separated,
 * the value JSON-quoted iff it contains whitespace, `=`, `"` or `\`.
 *
 * ⚠️ **Duplicates are kept, not collapsed into an object.** A duplicate column is a real defect this
 * subsystem has already shipped once (`level=INFO … level=error` from the MCP relay), and a reader
 * that folds columns into a `Record` makes it invisible — the second value silently wins and the
 * evidence is gone. This shape is what lets a reader see that bug rather than inherit it.
 */
export function parse(raw: string): Line {
  const columns: Array<readonly [string, string]> = []
  let index = 0
  while (index < raw.length) {
    while (index < raw.length && raw[index] === " ") index += 1
    const equals = raw.indexOf("=", index)
    if (equals === -1) break
    const key = raw.slice(index, equals)
    // A key with a space in it is not a column — it is prose that happens to contain `=`. Stop
    // rather than inventing a field name out of a sentence.
    if (key.length === 0 || key.includes(" ")) break
    index = equals + 1
    let value: string
    if (raw[index] === '"') {
      let cursor = index + 1
      while (cursor < raw.length) {
        if (raw[cursor] === "\\") cursor += 2
        else if (raw[cursor] === '"') break
        else cursor += 1
      }
      const literal = raw.slice(index, Math.min(cursor + 1, raw.length))
      try {
        value = JSON.parse(literal) as string
      } catch {
        value = literal
      }
      index = cursor + 1
    } else {
      let cursor = raw.indexOf(" ", index)
      if (cursor === -1) cursor = raw.length
      value = raw.slice(index, cursor)
      index = cursor
    }
    columns.push([key, value] as const)
  }
  const first = (name: string) => columns.find(([key]) => key === name)?.[1]
  const timestamp = first("timestamp")
  const time = timestamp === undefined ? undefined : Date.parse(timestamp)
  return {
    raw,
    columns,
    time: time === undefined || Number.isNaN(time) ? undefined : time,
    level: first("level"),
    event: first("event"),
  }
}

// ── filtering ───────────────────────────────────────────────────────────────────────────────────

/** Wire levels, least to most severe. `level` on a filter is a FLOOR, as every log UI means it. */
export const LEVEL_ORDER: Readonly<Record<Level, number>> = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_OF_COLUMN: Readonly<Record<string, Level>> = {
  DEBUG: "debug",
  INFO: "info",
  WARN: "warn",
  ERROR: "error",
  // Effect's `Fatal` has no wire level of its own; it is above `error` and must never be filtered
  // out by a floor of `error`, which is the one mistake a lookup table can silently make here.
  FATAL: "error",
}

export interface Filter {
  /** Minimum severity. A FLOOR: `warn` returns warnings and errors. */
  readonly level?: Level
  /** An event key, or a dotted PREFIX of one (`session.` matches every session event). */
  readonly key?: string
  readonly subsystem?: Subsystem
  /** Exact match against any correlation column whose value is this (`session.id=`, `pty.id=`, …). */
  readonly correlator?: string
  /** Case-insensitive substring over the whole raw line. */
  readonly match?: string
  /** Only lines at or after this epoch-millisecond instant. */
  readonly sinceMs?: number
}

export function matches(line: Line, filter: Filter): boolean {
  if (filter.level !== undefined) {
    const level = line.level === undefined ? undefined : LEVEL_OF_COLUMN[line.level]
    // An unrecognised level is NOT silently dropped by a severity floor. A line we cannot classify
    // is exactly the line a broken instance produces, and hiding it is how a reader answers "nothing
    // is wrong" about a log full of unparseable damage.
    if (level !== undefined && LEVEL_ORDER[level] < LEVEL_ORDER[filter.level]) return false
    if (level === undefined && filter.level !== "debug") return false
  }
  if (filter.key !== undefined && line.event !== filter.key && !(line.event ?? "").startsWith(filter.key))
    return false
  if (filter.subsystem !== undefined && !(line.event ?? "").startsWith(`${filter.subsystem}.`)) return false
  if (filter.sinceMs !== undefined && (line.time === undefined || line.time < filter.sinceMs)) return false
  if (filter.correlator !== undefined && !line.columns.some(([, value]) => value === filter.correlator)) return false
  if (filter.match !== undefined && !line.raw.toLowerCase().includes(filter.match.toLowerCase())) return false
  return true
}

// ── the two planes (AGENTS.md design-principle 4) ───────────────────────────────────────────────

export type Plane = "local" | "maintenance"

/** The line's own columns, which are not attributes and carry no user content by construction. */
const LINE_COLUMNS: Readonly<Record<string, ContentClass>> = {
  timestamp: "none",
  level: "none",
  run: "none",
  event: "none",
  // ⚠️ `message` is a DECLARED CONSTANT (`log-events.ts` refuses an interpolation marker in one), so
  // on a keyed line it is a fixed sentence and carries nothing. On an un-keyed line it is whatever a
  // raw `Effect.log*` passed — and `classOf` below only reaches this table for lines that carry an
  // `event=`, so the permissive answer is never given to prose of unknown provenance.
  message: "none",
}

/**
 * The content class of one column on one line — the ONE decision, read out of the declaration.
 *
 * `undefined` means *not classifiable*, and the caller treats that as the most restrictive answer.
 * That is ruling 4's *"an unclassified path is privileged by default"* applied to a read: a column
 * we cannot name is a column we cannot promise anything about — an `Effect.annotateLogs` annotation,
 * a span, a client-supplied field, a line from an older build.
 */
export function classOf(line: Line, column: string): ContentClass | undefined {
  const key = line.event
  if (key === undefined || !(key in EVENTS)) return undefined
  if (column in LINE_COLUMNS) return LINE_COLUMNS[column]
  const attributes = EVENTS[key as EventKey].attributes as Readonly<Record<string, AttributeClass>>
  const cls = attributes[column]
  return cls === undefined ? undefined : ATTRIBUTE_CLASSES[cls].content
}

/** What a withheld column becomes. Present, named, and obviously not the value — never dropped. */
export const withheld = (cls: ContentClass | undefined) => `‹${cls ?? "unclassified"}›`

/**
 * Render a line for one plane.
 *
 * `local` returns the line unchanged — **that is the point of the local plane**, and any narrowing
 * here would defeat the item this module exists for.
 *
 * `maintenance` keeps only columns whose class is `none`, which is `egressSafe()` by another name
 * and is derived from the same field `observability/telemetry.ts` derives its own from. Everything
 * else becomes {@link withheld}: the column STAYS so the reader can see that something was held
 * back and what kind of thing it was. A silently shorter line is a lie about what the log contains.
 */
export function project(line: Line, plane: Plane): string {
  if (plane === "local") return line.raw
  return line.columns
    .map(([key, value]) => {
      const cls = classOf(line, key)
      return `${key}=${cls === "none" ? quote(value) : withheld(cls)}`
    })
    .join(" ")
}

/** Re-quote a value the way `observability/logging.ts` does, so a projected line stays logfmt. */
const quote = (value: string) => (/^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value))

// ── who WROTE the value — a second axis, and not the same question as egress ────────────────────

/**
 * **Which attribute classes can hold words authored outside this instance.**
 *
 * `test/untrusted-framing.test.ts` asks one question of every tool: *does it carry bytes from a
 * party other than the user?* For a log reader the honest answer is **yes, in named columns** — and
 * that is what makes this tool different from `read`/`grep`, whose ledger entry reasons that
 * *"framing at the moment bytes ENTER is the cheap, honest place"*. For an arbitrary file that is
 * right: an earlier tool declared the provenance and re-declaring the whole filesystem untrusted
 * would be unaffordable and, for most files, false. **The log is the exception, because nothing
 * framed those bytes on the way in.** A log line is not a tool result; the writer wrote a foreign
 * program's error text into a column and no frame exists in a log file. So the declaration is the
 * only surviving record of who wrote a value, and reading it here is the cheap, honest place.
 *
 * ⚠️ **This is NOT derivable from `content`, which is why it is its own table and not ruling 6.**
 * `content` answers *may this leave the machine*; this answers *who authored it*. They disagree
 * exactly once and the disagreement is the point: `path` is `content: "user"` — never egresses,
 * because it carries the user's account and project names — and is nonetheless **not** a third
 * party's words. Framing a user's own directory as *"treat as data, not as instructions"* would be
 * ruling 2 broken in the other direction, the same mistake the retired `messenger.ts` note records
 * as *"a blanket prefix WOULD have mislabelled every instance fault as a stranger's words"*.
 *
 * ⚠️ **Exhaustive by construction.** A `Record<AttributeClass, …>` over the imported union, so a NEW
 * class in `log-events.ts` fails to compile here until somebody decides which side it is on. That is
 * the mechanism; the table is the decision.
 */
export const SPEAKS_FOR_OTHERS: Readonly<Record<AttributeClass, boolean>> = {
  /** A token from a closed vocabulary WE control. Ours by definition. */
  id: false,
  count: false,
  flag: false,
  /** An identifier this instance minted. Ours. */
  correlate: false,
  /** The user's own directory names. The user is not "a party other than the user". */
  path: false,
  /** Declared as *"free text from a person, a model, or a foreign process"* — the whole point. */
  text: true,
  /**
   * *"Our own error text"* by declaration — and it *"routinely embeds paths, payloads and prompts"*.
   * `Log.fault` on an `Error` thrown by an HTTP client carries the remote server's body verbatim, and
   * on a `Cause` it carries whatever a foreign process said. The wrapper is ours; the words need not
   * be.
   */
  fault: true,
  /** argv, failure reasons and config keys — several of which originate outside this process. */
  list: true,
}

/** Does a value of this class carry words that may have been authored outside this instance? */
export const speaksForOthers = (cls: AttributeClass): boolean => SPEAKS_FOR_OTHERS[cls]

/**
 * **Does this line, AS PROJECTED, still carry a value somebody else may have written?**
 *
 * Computed over the projection rather than the raw line, which is what makes the two mechanisms
 * compose instead of contradicting: under `maintenance` every class that speaks for others is
 * already withheld (each of them is `content !== "none"`, asserted in `log.test.ts` so a future
 * class cannot break the implication silently), so this is `false` by construction and nothing gets
 * a frame it does not need.
 *
 * ⚠️ **An UNCLASSIFIED column counts.** Not caution for its own sake — it is where the live foreign
 * values actually are. `POST /log` puts a caller's `client.extra.*` fields on the line as
 * ANNOTATIONS, which are not declared attributes and therefore have no class at all; and an
 * un-keyed line has no declaration to read, so nothing can vouch for its `message=`. The
 * `maintenance` projection already treats unclassified as the most restrictive answer (ruling 4),
 * and giving the same question two different answers in one file is the defect this repo keeps
 * finding.
 */
export function carriesForeign(line: Line, plane: Plane): boolean {
  const key = line.event
  const attributes =
    key === undefined || !(key in EVENTS)
      ? undefined
      : (EVENTS[key as EventKey].attributes as Readonly<Record<string, AttributeClass>>)
  return line.columns.some(([column]) => {
    const cls = classOf(line, column)
    // Withheld columns cannot carry anything: the value is gone, replaced by its class name.
    if (plane === "maintenance" && cls !== "none") return false
    if (cls === undefined) return true
    const declared = attributes?.[column]
    return declared !== undefined && speaksForOthers(declared)
  })
}

// ── the scan ────────────────────────────────────────────────────────────────────────────────────

export interface Query extends Filter {
  readonly directory: string
  readonly name: string
  /** Most recent matching lines to return. */
  readonly limit: number
  readonly plane?: Plane
  /** Scan ceiling; defaults to {@link SCAN_BYTES}. */
  readonly scanBytes?: number
}

export interface Result {
  /** Matching lines, OLDEST FIRST — reading order, so the newest answer is the last one. */
  readonly lines: ReadonlyArray<Line>
  /** Lines examined. `scanned === 0` with segments present means the filter, not an empty log. */
  readonly scanned: number
  /** True when the scan ceiling stopped it, so `count` is a floor rather than a total. */
  readonly truncated: boolean
  /** Segments actually opened, newest first. */
  readonly segments: ReadonlyArray<string>
}

/**
 * Walk segments newest-first, keeping the newest `limit` matches.
 *
 * ⚠️ It stops as soon as it HAS `limit` matches, including mid-segment. Reading newest-first means
 * the returned window is still the newest matching suffix, while old lines in that segment do not
 * pay parse cost after the answer is complete.
 */
export function scan(query: Query): Result {
  const budget = query.scanBytes ?? SCAN_BYTES
  const collected: Line[] = []
  const opened: string[] = []
  let scanned = 0
  let spent = 0
  let truncated = false
  for (const file of sources(query.directory, query.name)) {
    if (spent >= budget) {
      truncated = true
      break
    }
    const text = readSegment(file, budget - spent)
    spent += Buffer.byteLength(text)
    opened.push(file)
    const raws = text.split("\n")
    for (let index = raws.length - 1; index >= 0; index -= 1) {
      const raw = raws[index]!.trimEnd()
      if (raw.length === 0) continue
      scanned += 1
      const line = parse(raw)
      if (!matches(line, query)) continue
      collected.push(line)
      if (collected.length >= query.limit) break
    }
    if (collected.length >= query.limit) break
  }
  return { lines: collected.reverse(), scanned, truncated, segments: opened }
}

/** Histogram over the same walk, so `count` and `read` can never disagree about what matched. */
export function tally(query: Query, by: "event" | "level" | "subsystem"): ReadonlyArray<readonly [string, number]> {
  const totals = new Map<string, number>()
  const budget = query.scanBytes ?? SCAN_BYTES
  let spent = 0
  for (const file of sources(query.directory, query.name)) {
    if (spent >= budget) break
    const text = readSegment(file, budget - spent)
    spent += Buffer.byteLength(text)
    for (const raw of text.split("\n")) {
      if (raw.trim().length === 0) continue
      const line = parse(raw.trimEnd())
      if (!matches(line, query)) continue
      const event = line.event ?? "(unkeyed)"
      const bucket =
        by === "level"
          ? (line.level ?? "(none)")
          : by === "subsystem"
            ? event === "(unkeyed)"
              ? "(unkeyed)"
              : (event.split(".")[0] ?? "(unkeyed)")
            : event
      totals.set(bucket, (totals.get(bucket) ?? 0) + 1)
    }
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}
