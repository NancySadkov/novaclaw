import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Logging } from "@novaclaw/core/observability/logging"
import { LogRead } from "@novaclaw/core/observability/log-read"
import { LogTool } from "@novaclaw/core/tool/log"
import { LogReadRequest, LogReadResult, MAX_FILTER_CHARS } from "@novaclaw/protocol/groups/log"
import { EVENTS, SUBSYSTEMS } from "@novaclaw/schema/log-events"
import { Log } from "@novaclaw/schema/log"
import { Effect, Logger, References, Stream } from "effect"
import {
  LOG_BAD_DURATION_KIND,
  LOG_FILTER_TOO_LONG_KIND,
  LOG_UNKNOWN_SUBSYSTEM_KIND,
  clampLimit,
  diagnosticArchive,
  read,
  refuse,
} from "./log"

/**
 * **`POST /api/log/read`**, exercised.
 *
 * Three claims are under test and each one is a claim about the WIRE, not about a helper:
 *
 *  1. **The route cannot be pointed at another file.** Structural: the request schema has no field
 *     that could name one.
 *  2. **`plane:"maintenance"` withholds exactly what the class table says and nothing else** — and
 *     every absence below is paired, IN THE SAME RUN, with the same value present under `local`.
 *     An absence assertion on its own passes when the value was never there, which is how several
 *     vacuous tests shipped in this repo on 2026-08-07.
 *  3. **There is exactly one renderer of a log line.** The response carries `text` and nothing a
 *     client could re-render from.
 *
 * ⚠️ **The fixture lines are built through the PRODUCTION formatter from a REAL declaration**, not
 * hand-typed. 3g's sharpest mutation produced 2 red instead of 6 because its fixture used a column
 * name (`content=`) the declaration does not have — so the assertion was passing through the
 * *unclassified* arm and proving nothing about the class table. Generating the line from `EVENTS`
 * makes that failure mode unreachable, and {@link FIXTURE_SHAPE} fails loudly if the declaration
 * this file leans on ever changes shape.
 *
 * ⚠️ **The sentinel is `zzsentinelzz…`, deliberately NOT a Windows path.** `JSON.stringify` escapes
 * `\`, so `expect(text).not.toContain("C:\\Users\\…")` can never fire — an absence assertion that
 * is true for the wrong reason.
 */

// ── the fixture, generated from the live declaration ────────────────────────────────────────────

/**
 * One declared event carrying all three shapes this route has to tell apart: a content-free column
 * (`id`), a withheld-but-ours column (`path`), and a withheld column that speaks for others
 * (`fault`). Asserted below rather than assumed — if the declaration loses one of them, this file
 * says so instead of quietly testing two thirds of the question.
 */
const FIXTURE_EVENT = "skill.scan.failed" as const
const FIXTURE_SHAPE = { "skill.scope": "id", "skill.directory": "path", "skill.error": "fault" } as const

const SCOPE = "zzsentinelscopezz"
const DIRECTORY = "/zzsentineldirzz/projects"
const FAULT = "zzsentinelfaultzz: the foreign process said this"

/** Capture what the PRODUCTION formatter emits, so the fixture is a real line and not a guess. */
function emit(effect: Effect.Effect<void>): string {
  const captured: string[] = []
  const capture = Logger.map(Logging.formatter("testrun0"), (line) => {
    captured.push(line)
  })
  Effect.runSync(
    effect.pipe(
      Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Debug"),
    ),
  )
  return captured[0]!.trimEnd()
}

const fixtureLine = () =>
  emit(
    Log.event(FIXTURE_EVENT, {
      "skill.scope": SCOPE,
      "skill.directory": DIRECTORY,
      "skill.error": FAULT,
    }),
  )

/** A second line under a DIFFERENT subsystem, so the subsystem/level filters have something to exclude. */
const otherLine = () => emit(Log.event("log.file.usage", { "log.bytes": 1, "log.active.bytes": 1, "log.segments": 0 }))

/** A log directory on disk. OS temp — AGENTS.md principle 11(b). */
function fixtureSource(lines: ReadonlyArray<string>): LogTool.Source {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-logread-"))
  // ⚠️ `\n` explicitly: a CRLF fixture would be parsed with a trailing `\r` glued to the last value
  // and every column assertion below would be testing the wrong string.
  fs.writeFileSync(path.join(directory, "novaclaw.log"), `${lines.join("\n")}\n`, "utf8")
  return { directory, name: "novaclaw", now: () => Date.now() }
}

// ── 1. the load-bearing refusal: no field can name another file ─────────────────────────────────

describe("refusal 1 — the source is derived, and the wire cannot name another one", () => {
  test("the request schema declares no directory/file/path/name field", () => {
    const declared = Object.keys((LogReadRequest as unknown as { fields: Record<string, unknown> }).fields)
    // PRESENCE first, so this is not an assertion over an empty list that a schema-shape change
    // could silently turn vacuous.
    expect(declared).toContain("plane")
    expect(declared).toContain("match")
    expect(declared.length).toBeGreaterThan(5)
    for (const forbidden of ["directory", "file", "path", "name", "source", "root", "segment"])
      expect(declared).not.toContain(forbidden)
  })

  test("the tool's instance source is the one answer, and it is not a parameter", () => {
    // `read()` takes its source as an ARGUMENT so a test can point it at a fixture; the HANDLER
    // passes `LogTool.instanceSource()` and the payload has nothing that reaches this seam.
    expect(LogTool.instanceSource().name).toBe("novaclaw")
    expect(typeof LogTool.instanceSource().directory).toBe("string")
  })
})

describe("diagnostic export", () => {
  test("streams only the bounded maintenance projection from the injected instance source", async () => {
    const source = fixtureSource([fixtureLine()])
    const chunks = await Effect.runPromise(diagnosticArchive(source).pipe(Stream.runCollect))
    const text = new TextDecoder().decode(Buffer.concat(Array.from(chunks, (chunk) => Buffer.from(chunk))))

    expect(text).toContain("projection=maintenance source=instance-log window=1d")
    expect(text).toContain("skill.directory=‹user›")
    expect(text).not.toContain(DIRECTORY)
    expect(text).not.toContain(FAULT)
  })
})

// ── 2. the refusals a schema cannot express ─────────────────────────────────────────────────────

describe("refusal 2 — a filter that names nothing is a 400, never an empty result", () => {
  test("an unknown subsystem is refused and the message names the real set", () => {
    const refusal = refuse({ subsystem: "nosuchsubsystem" })
    expect(refusal?.kind).toBe(LOG_UNKNOWN_SUBSYSTEM_KIND)
    expect(refusal?.field).toBe("subsystem")
    // The repair is IN the message, from the live table — not a hard-coded list that can rot.
    for (const name of Object.keys(SUBSYSTEMS)) expect(refusal?.message).toContain(name)
  })

  test("every declared subsystem passes, so the check above is not refusing everything", () => {
    for (const name of Object.keys(SUBSYSTEMS)) expect(refuse({ subsystem: name })).toBeUndefined()
    expect(Object.keys(SUBSYSTEMS).length).toBeGreaterThan(5)
  })

  test("an unparseable duration is refused; the real ones are not", () => {
    expect(refuse({ since: "yesterday" })?.kind).toBe(LOG_BAD_DURATION_KIND)
    expect(refuse({ since: "4h" })).toBeUndefined()
    expect(refuse({ since: "30m" })).toBeUndefined()
    expect(refuse({ since: "2d" })).toBeUndefined()
  })

  test("an oversize filter is refused per field, and one character under is not", () => {
    for (const field of ["key", "subsystem", "correlator", "match", "since"] as const) {
      const refusal = refuse({ [field]: "z".repeat(MAX_FILTER_CHARS + 1) })
      expect(refusal?.kind).toBe(LOG_FILTER_TOO_LONG_KIND)
      expect(refusal?.field).toBe(field)
    }
    // PAIRING: at the cap the length check is silent, so the refusals above are about LENGTH and
    // not about the field being present at all.
    expect(refuse({ match: "z".repeat(MAX_FILTER_CHARS) })).toBeUndefined()
  })

  test("limit is CLAMPED, not refused — a limit is a preference", () => {
    expect(clampLimit(undefined)).toBe(LogTool.DEFAULT_LIMIT)
    expect(clampLimit(10_000)).toBe(LogTool.MAX_LIMIT)
    expect(clampLimit(0)).toBe(1)
    expect(clampLimit(-5)).toBe(1)
    expect(clampLimit(Number.NaN)).toBe(LogTool.DEFAULT_LIMIT)
    expect(clampLimit(12)).toBe(12)
  })
})

// ── 3. the two planes, every absence paired with a presence in the same run ─────────────────────

describe("the plane projection is the class table, and the default is local", () => {
  test("the declaration this file leans on still carries all three shapes", () => {
    expect(EVENTS[FIXTURE_EVENT].attributes).toEqual(FIXTURE_SHAPE)
  })

  test("local returns the user's own words; maintenance withholds them and NAMES the class", () => {
    const source = fixtureSource([fixtureLine()])

    const local = read({}, source)
    // PRESENCE — the sentinels really are on the line, so every absence below is about the
    // projection and not about a fixture that never carried them.
    expect(local.plane).toBe("local")
    expect(local.lines).toBe(1)
    expect(local.text).toContain(SCOPE)
    expect(local.text).toContain(DIRECTORY)
    expect(local.text).toContain("zzsentinelfaultzz")

    const maintenance = read({ plane: "maintenance" }, source)
    expect(maintenance.lines).toBe(1)
    // ABSENCE — the two `content:"user"` columns are gone…
    expect(maintenance.text).not.toContain(DIRECTORY)
    expect(maintenance.text).not.toContain("zzsentinelfaultzz")
    // …and NAMED, not dropped: a silently shorter line is a lie about what the log contains.
    expect(maintenance.text).toContain("skill.directory=‹user›")
    expect(maintenance.text).toContain("skill.error=‹user›")
    // …while the content-free column and the line's own columns survive, which is what makes the
    // two assertions above about the CLASS rather than about redacting everything.
    expect(maintenance.text).toContain(SCOPE)
    expect(maintenance.text).toContain(`event=${FIXTURE_EVENT}`)
    expect(maintenance.text).toContain("level=ERROR")
  })

  test("plane defaults to local — the read is for repairing this instance", () => {
    const source = fixtureSource([fixtureLine()])
    expect(read({}, source).text).toBe(read({ plane: "local" }, source).text)
    expect(read({}, source).plane).toBe("local")
  })

  test("the untrusted frame rides the LOCAL block and is absent from maintenance", () => {
    const source = fixtureSource([fixtureLine()])
    // The line carries a `fault` column, which `SPEAKS_FOR_OTHERS` declares foreign.
    expect(LogRead.SPEAKS_FOR_OTHERS.fault).toBe(true)
    expect(read({}, source).text.startsWith(`[${LogTool.FOREIGN_LABEL}`)).toBe(true)
    // Under maintenance every foreign class has already been withheld, so announcing a source that
    // sent nothing would be a false statement about the content beneath it.
    expect(read({ plane: "maintenance" }, source).text.startsWith("[")).toBe(false)
  })
})

// ── 4. one renderer, enforced by the shape of the wire ──────────────────────────────────────────

describe("there is exactly one renderer of a log line", () => {
  test("the response carries text and nothing structured to re-render from", () => {
    const declared = Object.keys((LogReadResult as unknown as { fields: Record<string, unknown> }).fields)
    expect(declared.sort()).toEqual(["lines", "plane", "scanned", "text", "truncated"])
  })

  test("the rendered text IS formatLines' output, byte for byte", () => {
    const source = fixtureSource([fixtureLine(), otherLine()])
    const scanned = LogRead.scan({ directory: source.directory, name: source.name, limit: 40, plane: "local" })
    expect(read({}, source).text).toBe(LogTool.formatLines(scanned.lines, "local"))
    // PRESENCE: the walk actually found both lines, so the equality above is not two empty strings.
    expect(scanned.lines.length).toBe(2)
  })

  test("every value on the wire is a scalar — nothing a client could project itself", () => {
    const source = fixtureSource([fixtureLine()])
    for (const value of Object.values(read({}, source))) expect(["string", "number", "boolean"]).toContain(typeof value)
  })
})

// ── 5. the filters, and the empty state that must not lie ───────────────────────────────────────

describe("filters and empty states", () => {
  test("subsystem and level narrow the same walk", () => {
    const source = fixtureSource([fixtureLine(), otherLine()])
    expect(read({}, source).lines).toBe(2)
    expect(read({ subsystem: "skill" }, source).lines).toBe(1)
    expect(read({ subsystem: "log" }, source).lines).toBe(1)
    expect(read({ level: "error" }, source).lines).toBe(1)
    expect(read({ match: "zzsentineldirzz" }, source).lines).toBe(1)
    expect(read({ key: "skill." }, source).lines).toBe(1)
  })

  test("an absent log is scanned:0, a filtered-out log is not — two different facts", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-logread-empty-"))
    const absent = read({}, { directory: empty, name: "novaclaw", now: () => Date.now() })
    expect(absent.lines).toBe(0)
    expect(absent.scanned).toBe(0)
    expect(absent.text).toBe("")

    const source = fixtureSource([fixtureLine()])
    const filtered = read({ match: "nothing-matches-this" }, source)
    expect(filtered.lines).toBe(0)
    // The distinguishing fact: the reader looked at a line and rejected it.
    expect(filtered.scanned).toBeGreaterThan(0)
  })

  test("an unreadable segment is an answer, not a throw", () => {
    const source = fixtureSource([fixtureLine()])
    // A rotated segment whose gzip stream is garbage. `readSegment` must answer "" for it and the
    // active segment must still be served — a reader that dies on one corrupt file answers nothing
    // about the good one beside it.
    fs.writeFileSync(path.join(source.directory, "novaclaw-20260101T000000000Z.log.gz"), "not gzip at all")
    const result = read({}, source)
    expect(result.lines).toBe(1)
    expect(result.text).toContain(SCOPE)
  })
})
