/**
 * **The log tier measures itself, once per boot — and does not open a second writer to do it.**
 *
 * `` Phase 2 handed Phase 3 exactly one deliverable with a ⭐ on it: *"the
 * bytes-written-per-hour event the defaults table asks for… Until it exists the Phase-2 defaults
 * table is still a guess — do not cite 8 MB / 256 MB / 30 d as measured."* This is that event
 * (`log.file.usage` + `log.file.rate`) proved end to end: not that the declaration exists, but that
 * a real `Observability.layer` boot writes the line INTO `novaclaw.log` with the right numbers on it.
 *
 * ── the two things that could silently be false ─────────────────────────────────────────────────
 *
 * 1. **The line could go to the wrong logger.** `Effect.log*` run during layer CONSTRUCTION uses
 *    whatever logger was ambient, which is stdout — so the event would "work" in every unit test and
 *    write nothing to the file it is about. That is why `observability.ts` provides the logger layer
 *    to the report, and why this test reads the FILE rather than a captured logger.
 * 2. **Providing that layer twice could BUILD it twice**, which would mean two `LogFile.Writer`s on
 *    one path — two descriptors, two exit hooks, two rotation owners. Effect's memo map says no;
 *    that is an inference about a library, so the fixture counts the writers that were actually open
 *    and the negative control below makes the same count come back 2.
 *
 * **NEGATIVE CONTROLS, run rather than asserted (2026-08-08, win32, bun 1.3.14):**
 *
 * | mutation | result |
 * |---|---|
 * | `NOVACLAW_LOG_DOUBLE=1` (the report gets its OWN logger layer) | `writers` = **2**, so the `=== 1` assertion is two-valued |
 * | seeded first line at `now` instead of hours ago | **no `log.file.rate` line**, so the rate is not emitted unconditionally |
 * | (recorded at the bottom of this file) | |
 */
import { describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import path from "node:path"
import { LogRead } from "@novaclaw/core/observability/log-read"
import { LogFile } from "@novaclaw/core/observability/log-file"
import { tmpdir } from "./fixture/tmpdir"

const FIXTURE = path.join(import.meta.dir, "fixture", "log-usage-boot.ts")

interface Report {
  log: string
  writers: number
  content: string | null
}

async function boot(home: string, extra: Record<string, string> = {}): Promise<Report> {
  const child = Bun.spawn([process.execPath, FIXTURE], {
    env: { ...process.env, NOVACLAW_HOME: home, ...extra },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const line = stdout.trim().split("\n").at(-1) ?? ""
  if (!line.startsWith("{"))
    throw new Error(`the fixture printed no report (exit ${exitCode}).\nstdout: ${stdout}\nstderr: ${stderr}`)
  return JSON.parse(line) as Report
}

/**
 * Seed a log whose FIRST line is `hoursAgo` old and whose size is `bytes`, so the rate the boot
 * measures is arithmetic this test can predict rather than whatever the machine happened to write.
 */
function seedLog(home: string, hoursAgo: number, bytes: number): string {
  const directory = path.join(home, "data", "log")
  fsSync.mkdirSync(directory, { recursive: true })
  const file = path.join(directory, "novaclaw.log")
  const first = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
  const head = `timestamp=${first} level=INFO run=seed event=filesystem.watcher.start message="watcher backend"\n`
  const filler = `timestamp=${first} level=INFO run=seed message=${"x".repeat(120)}\n`
  let text = head
  while (Buffer.byteLength(text) + Buffer.byteLength(filler) <= bytes) text += filler
  fsSync.writeFileSync(file, text)
  return file
}

const columns = (line: string) => Object.fromEntries(LogRead.parse(line).columns)
const lineFor = (content: string, key: string) =>
  content.split("\n").find((raw) => raw.includes(`event=${key} `) || raw.endsWith(`event=${key}`))

describe("the boot-time log usage measurement", () => {
  test("a real Observability boot writes log.file.usage AND log.file.rate into novaclaw.log, from ONE writer", async () => {
    await using dir = await tmpdir()
    // 3 hours of history and ~40 KB of it: 40960 / 3 ≈ 13653 bytes/hour, which the boot must
    // re-derive from the file rather than from anything this test tells it.
    const file = seedLog(dir.path, 3, 40 * 1024)
    const seeded = fsSync.statSync(file).size

    const report = await boot(dir.path)

    // ── 2: exactly one writer was open while the line was written ──────────────────────────────
    expect(report.writers).toBe(1)

    // ── 1: the line is in the FILE, not on stdout ──────────────────────────────────────────────
    expect(report.content).not.toBeNull()
    const content = report.content!
    const usage = lineFor(content, "log.file.usage")
    expect(usage).toBeDefined()
    const usageColumns = columns(usage!)
    expect(usageColumns["level"]).toBe("INFO")
    expect(usageColumns["message"]).toBe("log directory usage")
    // The measurement is taken BEFORE this line is written, so it reports the seeded size exactly —
    // an off-by-one-line answer here would mean the event counts itself.
    expect(Number(usageColumns["log.active.bytes"])).toBe(seeded)
    expect(Number(usageColumns["log.bytes"])).toBe(seeded)
    expect(Number(usageColumns["log.segments"])).toBe(0)

    const rate = lineFor(content, "log.file.rate")
    expect(rate).toBeDefined()
    const rateColumns = columns(rate!)
    expect(Number(rateColumns["log.span.hours"])).toBeGreaterThanOrEqual(2.9)
    expect(Number(rateColumns["log.span.hours"])).toBeLessThanOrEqual(3.1)
    // The division is checkable off the line itself, which is why the numerator and denominator ship
    // beside the quotient.
    const perHour = Number(rateColumns["log.bytes.per.hour"])
    expect(perHour).toBeGreaterThan(seeded / 3.2)
    expect(perHour).toBeLessThan(seeded / 2.8)
  }, 60_000)

  test("NEGATIVE CONTROL: a second logger layer really does open a second writer", async () => {
    await using dir = await tmpdir()
    seedLog(dir.path, 3, 8 * 1024)
    const report = await boot(dir.path, { NOVACLAW_LOG_DOUBLE: "1" })
    // If this were also 1, the `=== 1` above would be asserting a constant.
    expect(report.writers).toBe(2)
  }, 60_000)

  test("NEGATIVE CONTROL: too short a span emits the size line and NO rate line", async () => {
    await using dir = await tmpdir()
    // A minute of history — under `MIN_RATE_SPAN_MS`. A rate over a minute is not a rate, and a
    // sentinel would read as one.
    seedLog(dir.path, 1 / 60, 8 * 1024)
    const report = await boot(dir.path)
    expect(report.content).not.toBeNull()
    expect(lineFor(report.content!, "log.file.usage")).toBeDefined()
    expect(lineFor(report.content!, "log.file.rate")).toBeUndefined()
  }, 60_000)
})

describe("LogRead.usage — the measurement itself", () => {
  test("counts rotated segments and the active file, and refuses a rate it cannot justify", async () => {
    await using dir = await tmpdir()
    const name = "novaclaw"
    const first = new Date(Date.now() - 4 * 3_600_000).toISOString()
    const active = `timestamp=${first} level=INFO run=a message=hello\n${"y".repeat(999)}\n`
    fsSync.writeFileSync(path.join(dir.path, `${name}.log`), active)
    const rotated = path.join(dir.path, `${name}-${LogFile.stampOf(new Date(Date.now() - 86_400_000))}.log.gz`)
    fsSync.writeFileSync(rotated, "z".repeat(500))

    const measured = LogRead.usage(dir.path, name)
    expect(measured.activeBytes).toBe(Buffer.byteLength(active))
    expect(measured.segments).toBe(1)
    expect(measured.bytes).toBe(Buffer.byteLength(active) + 500)
    expect(measured.spanHours!).toBeGreaterThan(3.9)
    expect(measured.bytesPerHour!).toBeGreaterThan(0)

    // A directory that does not exist is zeroes and no rate — never a throw, because this runs on
    // the boot path of a subsystem whose whole contract is that it cannot take the instance down.
    const absent = LogRead.usage(path.join(dir.path, "nope"), name)
    expect(absent).toEqual({ bytes: 0, activeBytes: 0, segments: 0 })

    // An active segment with no parseable first line yields no span and therefore no rate — a file
    // full of damage must not produce a confident number.
    await using other = await tmpdir()
    fsSync.writeFileSync(path.join(other.path, `${name}.log`), "this is not logfmt at all\n")
    const damaged = LogRead.usage(other.path, name)
    expect(damaged.activeBytes).toBeGreaterThan(0)
    expect(damaged.spanHours).toBeUndefined()
    expect(damaged.bytesPerHour).toBeUndefined()
  })
})
