/**
 * **The log writer: segments, rotation, retention — and the rule that it may never take the
 * instance down.**
 *
 * Every degradation claim here is paired with the **unguarded twin of
 * the same operation, against the same paths, in the same run** — the shape `boot-degrade.test.ts`
 * established, and for the same reason: *"it survived"* is trivially true if the poison stopped
 * biting, and a green test that cannot fail is worse than no test. So each failure-mode test also
 * asserts that the injected fault really fired, or that the raw operation really loses the bytes.
 *
 * ⚠️ **A fault injector written in POSIX shape is a no-op on win32.** Nothing here matches on path
 * strings; the injectors are the writer's own seams (`appendFn`, `renameFn`, `compress`), and each
 * one counts its own calls so a silent no-op fails rather than passes.
 */
import { describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { Global } from "../global"
import { LogFile } from "./log-file"
import { tmpdir } from "../../test/fixture/tmpdir"

const DAY = 24 * 60 * 60 * 1000
const line = (index: number) => `timestamp=2026-08-07T00:00:00.000Z level=INFO run=test seq=${index}\n`

/** A rotated segment on disk, stamped at `time`, without going through the writer. */
function plant(directory: string, name: string, time: number, bytes: number, compressed = true) {
  const file = path.join(directory, `${name}-${LogFile.stampOf(new Date(time))}.log${compressed ? ".gz" : ""}`)
  fsSync.writeFileSync(file, Buffer.alloc(bytes, 0x61))
  return file
}

const names = (directory: string) => fsSync.readdirSync(directory).sort()

describe("the filename grammar is the contract", () => {
  test("a stamp is Windows-legal and sorts chronologically", () => {
    const stamp = LogFile.stampOf(new Date("2026-08-07T22:13:14.123Z"))
    expect(stamp).toBe("20260807T221314123Z")
    // `:` is illegal in a Windows filename, and `toISOString` is full of them. This is the whole
    // reason the grammar is not just the ISO string.
    expect(stamp).not.toContain(":")
    expect(LogFile.timeOfStamp(stamp)).toBe(Date.parse("2026-08-07T22:13:14.123Z"))

    // Lexicographic order IS chronological order — the property `ls` and the retention sweep both
    // rely on. Checked against a shuffled set spanning a year, a month, a day and a millisecond
    // boundary, because a fixed-width format is exactly where an off-by-one padding bug hides.
    const times = [
      Date.parse("2025-12-31T23:59:59.999Z"),
      Date.parse("2026-01-01T00:00:00.000Z"),
      Date.parse("2026-08-07T22:13:14.123Z"),
      Date.parse("2026-08-07T22:13:14.124Z"),
      Date.parse("2026-09-01T00:00:00.000Z"),
    ]
    const shuffled = [times[3]!, times[0]!, times[4]!, times[1]!, times[2]!]
    expect(shuffled.map((t) => LogFile.stampOf(new Date(t))).sort()).toEqual(
      times.map((t) => LogFile.stampOf(new Date(t))),
    )
  })

  test("segmentsIn reads only our segments, oldest first — and a foreign file is not one", async () => {
    await using dir = await tmpdir()
    const old = plant(dir.path, "novaclaw", Date.parse("2026-01-01T00:00:00.000Z"), 10)
    const recent = plant(dir.path, "novaclaw", Date.parse("2026-08-01T00:00:00.000Z"), 20, false)
    // Everything a real log directory might also hold. None of it is a segment.
    fsSync.writeFileSync(path.join(dir.path, "novaclaw.log"), "active")
    fsSync.writeFileSync(path.join(dir.path, "novaclaw-notastamp.log.gz"), "x")
    fsSync.writeFileSync(path.join(dir.path, "novaclaw-20260801T000000000Z.log.gz.tmp"), "x")
    fsSync.writeFileSync(path.join(dir.path, "other-20260801T000000000Z.log.gz"), "x")

    const found = LogFile.segmentsIn(dir.path, "novaclaw")
    expect(found.map((segment) => segment.file)).toEqual([old, recent])
    expect(found[0]!.compressed).toBe(true)
    expect(found[1]!.compressed).toBe(false)
    expect(found[1]!.bytes).toBe(20)

    // An unreadable directory is an empty list, not a throw: a retention sweep must never be able
    // to fail whatever triggered it.
    expect(LogFile.segmentsIn(path.join(dir.path, "does-not-exist"), "novaclaw")).toEqual([])
  })
})

describe("rotation", () => {
  test("the active segment stays plain; the rotated one is gzipped and zcat-readable", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const writer = LogFile.open({ file, segmentBytes: 400 })
    for (let index = 0; index < 20; index++) writer.write(line(index), true)
    await writer.idle()
    writer.close()

    expect(writer.rotations).toBeGreaterThanOrEqual(1)
    const segments = LogFile.segmentsIn(dir.path, "novaclaw")
    expect(segments.length).toBeGreaterThanOrEqual(1)
    expect(segments.every((segment) => segment.compressed)).toBe(true)

    // The whole point of gzip over zstd (§0.5): a naive miner needs `zcat`/`zgrep` and nothing else.
    const restored = segments
      .map((segment) => zlib.gunzipSync(fsSync.readFileSync(segment.file)).toString("utf8"))
      .join("")
    const all = restored + fsSync.readFileSync(file, "utf8")
    // Not one line was lost across the rotations, and the active segment is readable as text.
    for (let index = 0; index < 20; index++) expect(all).toContain(`seq=${index}\n`)
    expect(fsSync.readFileSync(file, "utf8").startsWith("timestamp=")).toBe(true)
    expect(fsSync.readdirSync(dir.path).some((entry) => entry.endsWith(".tmp"))).toBe(false)
  })

  test("a segment under the size stays put (negative control)", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const writer = LogFile.open({ file, segmentBytes: 8 * 1024 * 1024 })
    for (let index = 0; index < 20; index++) writer.write(line(index), true)
    await writer.idle()
    writer.close()

    expect(writer.rotations).toBe(0)
    expect(LogFile.segmentsIn(dir.path, "novaclaw")).toEqual([])
    expect(names(dir.path)).toEqual(["novaclaw.log"])
  })

  test("close BEFORE rename — the unguarded twin silently writes into the sealed segment", async () => {
    await using dir = await tmpdir()

    // ── the control: rename with the handle still open, exactly what an external sweeper does ────
    // ⚠️ The design sketch predicted `EPERM`/`EBUSY` here on Windows. It does not happen —
    // libuv passes FILE_SHARE_DELETE, the rename SUCCEEDS, and the descriptor follows the file.
    // That is a worse failure than the predicted one, and this is the arm that proves it bites.
    const raw = path.join(dir.path, "raw.log")
    const sealed = path.join(dir.path, "raw-sealed.log")
    fsSync.writeFileSync(raw, "")
    const fd = fsSync.openSync(raw, "a")
    fsSync.renameSync(raw, sealed) // succeeds on win32; the premise in the plan is wrong
    fsSync.writeSync(fd, "after-rotation\n")
    fsSync.closeSync(fd)
    expect(fsSync.readFileSync(sealed, "utf8")).toContain("after-rotation")
    expect(fsSync.existsSync(raw)).toBe(false) // the "fresh active segment" does not even exist

    // ── the claim: the writer closes first, so the line lands in the NEW active segment ──────────
    const file = path.join(dir.path, "novaclaw.log")
    const writer = LogFile.open({ file, segmentBytes: 8 * 1024 * 1024 })
    writer.write(line(0), true)
    writer.rotate()
    writer.write("after-rotation\n", true)
    await writer.idle()
    writer.close()

    expect(fsSync.readFileSync(file, "utf8")).toBe("after-rotation\n")
    const segments = LogFile.segmentsIn(dir.path, "novaclaw")
    expect(segments).toHaveLength(1)
    expect(zlib.gunzipSync(fsSync.readFileSync(segments[0]!.file)).toString("utf8")).toBe(line(0))
  })

  test("a refused rename does not lose lines, and the bound is still mechanical", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    let renames = 0
    const renameFn = () => {
      renames++
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    }
    // The injector really throws — the no-op-injector trap, closed by construction.
    expect(() => renameFn()).toThrow("EBUSY")
    renames = 0

    const writer = LogFile.open({ file, segmentBytes: 200, renameFn })
    for (let index = 0; index < 40; index++) writer.write(line(index), true)
    await writer.idle()

    expect(renames).toBeGreaterThan(0)
    expect(writer.rotationsBlocked).toBe(renames)
    expect(writer.rotations).toBe(0)
    // The instance kept logging through a filesystem that refuses to rotate…
    expect(fsSync.readFileSync(file, "utf8")).toContain("seq=39")
    // …and the file is still BOUNDED: past the stuck multiple it is truncated rather than growing
    // forever. Without this, one stuck reader would buy unlimited disk.
    //
    // ⚠️ **This assertion caught the fix's own bug and is why it is worth its line.** The first
    // implementation truncated with `ftruncateSync(fd, 0)` on the append-mode handle, which throws
    // `EPERM` on win32 — SILENTLY, because the `catch` around it exists so that a failing truncate
    // cannot crash the instance. Every other counter was correct and the bound was simply not
    // enforced. `truncations` is the observable that told the difference.
    expect(writer.truncations).toBeGreaterThan(0)
    expect(fsSync.statSync(file).size).toBeLessThan(200 * LogFile.ROTATION_STUCK_MULTIPLE + 4096)
    writer.close()
  })
})

describe("retention — one bound, enforced over the directory", () => {
  test("the byte budget evicts oldest-first and never the active segment", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const oldest = plant(dir.path, "novaclaw", now - 3 * DAY, 1000)
    const middle = plant(dir.path, "novaclaw", now - 2 * DAY, 1000)
    const newest = plant(dir.path, "novaclaw", now - 1 * DAY, 1000)

    const writer = LogFile.open({ file, totalBytes: 2500, now: () => new Date(now) })
    writer.write(line(0), true)
    writer.sweep()
    writer.close()

    expect(fsSync.existsSync(oldest)).toBe(false)
    expect(fsSync.existsSync(middle)).toBe(true)
    expect(fsSync.existsSync(newest)).toBe(true)
    expect(fsSync.existsSync(file)).toBe(true) // the active segment is never a candidate
  })

  test("age evicts even when the budget is nowhere near — and both directions are controlled", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const stale = plant(dir.path, "novaclaw", now - 40 * DAY, 10)
    const fresh = plant(dir.path, "novaclaw", now - 1 * DAY, 10)

    const writer = LogFile.open({ file, totalBytes: 1024 * 1024, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    writer.sweep()
    writer.close()

    // Age alone lets a debug session fill the disk in a day; size alone throws away a quiet
    // instance's only history. §2d asks for both, so both are asserted independently.
    expect(fsSync.existsSync(stale)).toBe(false)
    expect(fsSync.existsSync(fresh)).toBe(true)
  })

  test("an already-open writer reads a changed retention window at the sweep point", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const segment = plant(dir.path, "novaclaw", now - 10 * DAY, 10)
    let retention = 30 * DAY
    const writer = LogFile.open({
      file,
      totalBytes: 1024 * 1024,
      maxAgeMs: () => retention,
      now: () => new Date(now),
    })

    expect(writer.sweep()).toBe(0)
    expect(fsSync.existsSync(segment)).toBe(true)
    retention = 7 * DAY
    expect(writer.sweep()).toBe(10)
    expect(fsSync.existsSync(segment)).toBe(false)
    writer.close()
  })

  test("nothing is swept when the directory is inside both limits (negative control)", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    plant(dir.path, "novaclaw", now - 3 * DAY, 1000)
    plant(dir.path, "novaclaw", now - 2 * DAY, 1000)
    const writer = LogFile.open({ file, totalBytes: 1024 * 1024, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    expect(writer.sweep()).toBe(0)
    writer.close()
    expect(LogFile.segmentsIn(dir.path, "novaclaw")).toHaveLength(2)
  })

  test("opening the log sweeps, so a quiet instance still honours the age limit", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const stale = plant(dir.path, "novaclaw", now - 40 * DAY, 10)
    const fresh = plant(dir.path, "novaclaw", now - 1 * DAY, 10)

    // Nothing is written and nothing rotates — the instance merely STARTS. At the measured
    // 69.5 KB/day an 8 MB segment closes about every 16 weeks, so a rotation-only sweep would let a
    // quiet instance keep months of history while Settings promised 30 days.
    const writer = LogFile.open({ file, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    writer.close()

    expect(fsSync.existsSync(stale)).toBe(false)
    expect(fsSync.existsSync(fresh)).toBe(true)
    expect(writer.rotations).toBe(0)
  })

  /**
   * ⭐ **AGE ROTATION — the half `LogRead.usage` proved was missing, 2026-08-08.**
   *
   * The writer shipped size-only, and the sweep can only ever delete a segment that has been
   * SEALED. `LogRead.usage` over this machine's two real log directories reported **83 KB/day** and
   * **32 KB/day** with **`segments: 0` on both** — neither had ever rotated, so every test above
   * this one was proving a mechanism that, in production, nothing ever reached. The tests below are
   * the ones that would have caught that, and each carries the size-only twin as its control.
   */
  test("an active segment older than the age limit is sealed on the write path — the size-only twin is not", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const start = Date.parse("2026-06-01T00:00:00.000Z")
    let clock = start
    // A byte ceiling this segment will never come close to: the ONLY thing that can rotate it is age.
    const writer = LogFile.open({
      file,
      segmentBytes: 8 * 1024 * 1024,
      maxAgeMs: 30 * DAY,
      now: () => new Date(clock),
    })
    writer.write("timestamp=2026-06-01T00:00:00.000Z level=INFO run=a message=first\n", true)

    // THE CONTROL, in the same run against the same writer: 29 days in, size-only says nothing has
    // happened and neither does age. Without this arm, the assertion below would also pass against
    // a writer that rotated on every flush.
    clock = start + 29 * DAY
    writer.write("timestamp=x level=INFO run=a message=middle\n", true)
    expect(writer.rotations).toBe(0)
    expect(writer.rotationsByAge).toBe(0)

    clock = start + 31 * DAY
    writer.write("timestamp=y level=INFO run=a message=late\n", true)
    await writer.idle()
    expect(writer.rotations).toBe(1)
    expect(writer.rotationsByAge).toBe(1)
    // …and it did not then rotate on every subsequent flush, which is the loud version of this bug.
    clock = start + 31 * DAY + 1000
    writer.write("timestamp=z level=INFO run=a message=after\n", true)
    expect(writer.rotations).toBe(1)
    writer.close()
    await writer.idle()
    expect(LogFile.segmentsIn(dir.path, "novaclaw")).toHaveLength(1)
  })

  test("a segment inherited from an earlier run ages from ITS OWN first line, not from this boot", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    // A log left behind by a run 40 days ago. Nothing is written this boot — the instance merely
    // starts, which is §0.6's launch-triggered pattern.
    const old = new Date(now - 40 * DAY).toISOString()
    fsSync.writeFileSync(file, `timestamp=${old} level=INFO run=old message=ancient\n`)

    const writer = LogFile.open({ file, segmentBytes: 8 * 1024 * 1024, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    await writer.idle()
    writer.close()
    await writer.idle()

    // ⚠️ The claim is specifically that the clock did NOT reset at boot. If `activeSince` were taken
    // from the process's start instead of from the file's first line, a frequently restarted
    // instance would never age-rotate at all and this would be 0.
    expect(writer.rotationsByAge).toBe(1)
    expect(LogFile.segmentsIn(dir.path, "novaclaw")).toHaveLength(1)

    // THE CONTROL: the same boot against a log whose first line is one day old rotates nothing.
    await using fresh = await tmpdir()
    const freshFile = path.join(fresh.path, "novaclaw.log")
    const recent = new Date(now - 1 * DAY).toISOString()
    fsSync.writeFileSync(freshFile, `timestamp=${recent} level=INFO run=new message=recent\n`)
    const control = LogFile.open({
      file: freshFile,
      segmentBytes: 8 * 1024 * 1024,
      maxAgeMs: 30 * DAY,
      now: () => new Date(now),
    })
    control.close()
    expect(control.rotationsByAge).toBe(0)
    expect(LogFile.segmentsIn(fresh.path, "novaclaw")).toHaveLength(0)
  })

  test("firstLineTime reads the FIRST line's timestamp, and says nothing rather than guessing", async () => {
    await using dir = await tmpdir()
    const at = "2026-07-04T05:06:07.008Z"
    const good = path.join(dir.path, "good.log")
    fsSync.writeFileSync(good, `timestamp=${at} level=INFO run=a message=hello\ntimestamp=2026-08-01T00:00:00.000Z\n`)
    expect(LogFile.firstLineTime(good)).toBe(Date.parse(at))

    // Every way it may NOT answer. A confident wrong instant here would seal a segment early (data
    // churn) or never (the defect this whole block exists for), and both are silent.
    const empty = path.join(dir.path, "empty.log")
    fsSync.writeFileSync(empty, "")
    expect(LogFile.firstLineTime(empty)).toBeUndefined()
    const prose = path.join(dir.path, "prose.log")
    fsSync.writeFileSync(prose, "this is not logfmt at all\n")
    expect(LogFile.firstLineTime(prose)).toBeUndefined()
    const nonsense = path.join(dir.path, "nonsense.log")
    fsSync.writeFileSync(nonsense, "timestamp=not-a-date level=INFO\n")
    expect(LogFile.firstLineTime(nonsense)).toBeUndefined()
    // A first line longer than the read window is damage, not data.
    const huge = path.join(dir.path, "huge.log")
    fsSync.writeFileSync(huge, `timestamp=${at} message=${"x".repeat(20000)}\n`)
    expect(LogFile.firstLineTime(huge)).toBeUndefined()
    expect(LogFile.firstLineTime(path.join(dir.path, "absent.log"))).toBeUndefined()
  })

  test("an abandoned .gz.tmp is swept only past its grace period", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.now()
    const abandoned = path.join(dir.path, "novaclaw-20260101T000000000Z.log.gz.tmp")
    const inFlight = path.join(dir.path, "novaclaw-20260102T000000000Z.log.gz.tmp")
    fsSync.writeFileSync(abandoned, "half a gzip")
    fsSync.writeFileSync(inFlight, "half a gzip")
    const stale = new Date(now - LogFile.TMP_GRACE_MS - 60_000)
    fsSync.utimesSync(abandoned, stale, stale)

    const writer = LogFile.open({ file, totalBytes: 1024 * 1024, maxAgeMs: 30 * DAY })
    writer.sweep()
    writer.close()

    expect(fsSync.existsSync(abandoned)).toBe(false)
    // The grace period is what keeps this safe when two instances share one home, and therefore one
    // log directory: a peer's gzip in flight must not be deleted out from under it.
    expect(fsSync.existsSync(inFlight)).toBe(true)
  })

  test("🔴 a file the writer's grammar does not own is COUNTED in the ceiling and swept", async () => {
    /**
     * The ceiling claims to total the directory. It totalled the files matching this writer's own
     * filename grammar, so anything else written into `<data>/log` was invisible to BOTH halves of
     * retention — never deleted by age, never deleted by budget, and absent from the total the
     * budget is compared against. The measured case is the auto heap snapshot, which lands here at
     * RSS size (gigabytes) and holds every live string in the process, while the Settings row went
     * on saying the directory was capped.
     *
     * ⚠️ The budget below is the whole point: 5000 leaves the three segments (3000) comfortably
     * inside the ceiling, so ONLY counting the snapshot puts the directory over it. A sweep that
     * still totals its own grammar sweeps nothing here and this fails on the first assertion.
     */
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const oldest = plant(dir.path, "novaclaw", now - 3 * DAY, 1000)
    const middle = plant(dir.path, "novaclaw", now - 2 * DAY, 1000)
    const newest = plant(dir.path, "novaclaw", now - 1 * DAY, 1000)
    const snapshot = path.join(dir.path, "heap-1234-20260805T000000000Z.heapsnapshot")
    fsSync.writeFileSync(snapshot, Buffer.alloc(4000, 0x61))
    const stamped = new Date(now - 2 * DAY)
    fsSync.utimesSync(snapshot, stamped, stamped)

    const writer = LogFile.open({ file, totalBytes: 5000, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    writer.close()

    expect(fsSync.existsSync(snapshot)).toBe(false)
    // CONTROL — an ordinary log file is unaffected. Residue is evicted FIRST because the rotated
    // segments are the record and a diagnostic artefact is scratch: one 4 GB snapshot must never
    // evict a year of history on its way under the budget.
    expect([oldest, middle, newest].map((segment) => fsSync.existsSync(segment))).toEqual([true, true, true])
    expect(fsSync.existsSync(file)).toBe(true)
  })

  test("residue past the age limit goes; a peer's write in flight stays (both directions)", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.now()
    const abandoned = path.join(dir.path, "heap-1-abandoned.heapsnapshot")
    const inFlight = path.join(dir.path, "heap-2-inflight.heapsnapshot")
    fsSync.writeFileSync(abandoned, Buffer.alloc(64, 0x61))
    fsSync.writeFileSync(inFlight, Buffer.alloc(64, 0x61))
    const stale = new Date(now - LogFile.TMP_GRACE_MS - 60_000)
    fsSync.utimesSync(abandoned, stale, stale)

    // Everything is over this budget, so the grace period is the ONLY thing standing between the
    // sweep and the second file. Two instances can share one home and therefore one log directory;
    // a peer writing a snapshot right now is not litter.
    const writer = LogFile.open({ file, totalBytes: 10, maxAgeMs: 30 * DAY })
    writer.sweep()
    writer.close()

    expect(fsSync.existsSync(abandoned)).toBe(false)
    expect(fsSync.existsSync(inFlight)).toBe(true)
  })

  test("NEGATIVE CONTROL: residue inside both limits is counted and left alone", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const now = Date.parse("2026-08-07T00:00:00.000Z")
    const keep = path.join(dir.path, "heap-1234-20260806T000000000Z.heapsnapshot")
    fsSync.writeFileSync(keep, Buffer.alloc(4000, 0x61))
    const stamped = new Date(now - 2 * DAY)
    fsSync.utimesSync(keep, stamped, stamped)

    const writer = LogFile.open({ file, totalBytes: 1024 * 1024, maxAgeMs: 30 * DAY, now: () => new Date(now) })
    expect(writer.sweep()).toBe(0)
    writer.close()
    // Counted without being deleted: bounding the directory is not the same as emptying it, and a
    // sweep that took every foreign file on sight would delete a diagnostic the moment it was taken.
    expect(fsSync.existsSync(keep)).toBe(true)
    expect(LogFile.residueIn(dir.path, "novaclaw").map((entry) => entry.bytes)).toEqual([4000])
  })
})

describe("logging never takes the instance down", () => {
  test("an unwritable directory degrades instead of throwing — with the raw twin proving it bites", async () => {
    await using dir = await tmpdir()
    // The classic shape: `<data>/log` exists but is a FILE.
    const blocker = path.join(dir.path, "log")
    fsSync.writeFileSync(blocker, "not a directory")
    const file = path.join(blocker, "novaclaw.log")

    // The control: the raw syscalls this replaced really do throw against this exact path.
    expect(() => fsSync.mkdirSync(blocker, { recursive: true })).toThrow()
    expect(() => fsSync.openSync(file, "a")).toThrow()

    // The claim.
    const reasons: string[] = []
    const writer = LogFile.open({ file, onDegrade: (reason) => reasons.push(reason) })
    expect(writer.available).toBe(false)
    expect(writer.write(line(0))).toBe(false)
    expect(writer.dropped).toBe(1)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]!.length).toBeGreaterThan(0)
    // Every other entry point is safe too — this is the "no error channel" claim, exercised.
    expect(() => writer.flush()).not.toThrow()
    expect(() => writer.rotate()).not.toThrow()
    expect(() => writer.sweep()).not.toThrow()
    expect(() => writer.close()).not.toThrow()
  })

  test("a full disk mid-run degrades once, spills the pending lines, and keeps the process alive", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    let calls = 0
    let poisoned = false
    const appendFn = (fd: number, chunk: Buffer) => {
      calls++
      if (poisoned) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" })
      let offset = 0
      while (offset < chunk.length) offset += fsSync.writeSync(fd, chunk, offset, chunk.length - offset)
    }

    const reasons: string[] = []
    const writer = LogFile.open({ file, appendFn, mirrored: true, onDegrade: (reason) => reasons.push(reason) })
    writer.write(line(0), true)
    expect(calls).toBe(1) // the injector is on the real path, not decoration
    expect(writer.available).toBe(true) // …and it is two-valued: healthy until poisoned
    expect(fsSync.readFileSync(file, "utf8")).toBe(line(0))

    poisoned = true
    expect(() => writer.write(line(1), true)).not.toThrow()
    expect(calls).toBe(2)
    expect(writer.available).toBe(false)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toContain("ENOSPC")

    // Degrade is once, not per line, and later lines are counted rather than silently vanishing.
    expect(writer.write(line(2))).toBe(false)
    expect(writer.write(line(3))).toBe(false)
    expect(reasons).toHaveLength(1)
    expect(writer.dropped).toBe(2)
    writer.close()
    // The healthy line is intact on disk; the failed one never claimed to be written.
    expect(fsSync.readFileSync(file, "utf8")).toBe(line(0))
  })

  test("a refused truncation still leaves a usable handle — the branch whose failure is swallowed", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    let truncates = 0
    const truncateFn = () => {
      truncates++
      throw Object.assign(new Error("EPERM: operation not permitted, truncate"), { code: "EPERM" })
    }
    expect(() => truncateFn()).toThrow("EPERM") // the injector bites
    truncates = 0

    const writer = LogFile.open({
      file,
      segmentBytes: 200,
      renameFn: () => {
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" })
      },
      truncateFn,
    })
    for (let index = 0; index < 40; index++) writer.write(line(index), true)

    // Rotation refused AND truncation refused — the worst case, and the writer is still writing.
    expect(truncates).toBeGreaterThan(0)
    expect(writer.truncations).toBe(0)
    expect(writer.available).toBe(true)
    writer.write("still-alive\n", true)
    expect(fsSync.readFileSync(file, "utf8")).toContain("still-alive")
    // ⚠️ This is the regression the code comment names: the reopen used to live INSIDE the `try`,
    // so a refused truncate left `fd === undefined` with the state still `ok` — every later line
    // dropped in silence, no warning, nothing degraded. Green tests, no log.
    writer.close()
  })

  test("a line logged after close goes to stderr rather than into a buffer nobody will flush", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    const writer = LogFile.open({ file })
    writer.write(line(0), true)
    writer.close()

    // Shutdown ordering is not something a logger gets to assume. A late line must be REFUSED, so
    // the sink can put it on stderr — the alternative is buffering it into a writer whose timer is
    // cleared and whose exit-hook registration is gone, which loses it in silence.
    expect(writer.write(line(1))).toBe(false)
    expect(writer.dropped).toBe(1)
    expect(fsSync.readFileSync(file, "utf8")).toBe(line(0))
  })

  test("a failing gzip leaves the plain segment readable and no half-written .gz", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    let compressions = 0
    const compress = () => {
      compressions++
      throw new Error("zlib exploded")
    }
    expect(() => compress()).toThrow("zlib exploded") // the injector bites
    compressions = 0

    const writer = LogFile.open({ file, segmentBytes: 200, compress })
    for (let index = 0; index < 20; index++) writer.write(line(index), true)
    await writer.idle()
    writer.close()

    expect(compressions).toBeGreaterThan(0)
    const segments = LogFile.segmentsIn(dir.path, "novaclaw")
    expect(segments.length).toBeGreaterThan(0)
    // Both possible outcomes of a crash-or-failure mid-compression are readable by a naive miner.
    // Here it is the uncompressed one — still `grep`-able, still bounded by the same sweep.
    expect(segments.every((segment) => segment.compressed)).toBe(false)
    expect(fsSync.readFileSync(segments[0]!.file, "utf8")).toContain("seq=0")
    expect(names(dir.path).some((entry) => entry.endsWith(".tmp"))).toBe(false)
    // …and not one line was lost while compression was failing under it.
    // ⚠️ Read across the segments AND the active file, never the active file alone: a rotation can
    // land on the last write, and an empty active segment is then correct rather than data loss.
    // Asserting on `novaclaw.log` by itself made this test fail for a reason that was not a defect.
    const all =
      segments.map((segment) => fsSync.readFileSync(segment.file, "utf8")).join("") + fsSync.readFileSync(file, "utf8")
    for (let index = 0; index < 20; index++) expect(all).toContain(`seq=${index}\n`)
  })

  test("a torn write costs the last line and nothing else", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.log")
    let tear = false
    const appendFn = (fd: number, chunk: Buffer) => {
      if (!tear) {
        let offset = 0
        while (offset < chunk.length) offset += fsSync.writeSync(fd, chunk, offset, chunk.length - offset)
        return
      }
      // A crash in the middle of the write: half the bytes land, then the syscall never returns.
      fsSync.writeSync(fd, chunk, 0, Math.floor(chunk.length / 2))
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" })
    }

    const writer = LogFile.open({ file, appendFn, mirrored: true })
    writer.write(line(0), true)
    writer.write(line(1), true)
    tear = true
    writer.write("timestamp=torn level=INFO run=test tail=yes\n", true)
    writer.close()

    const lines = fsSync.readFileSync(file, "utf8").split("\n")
    // Every COMPLETE line before the tear parses; only the trailing fragment is damaged, which is
    // what a logfmt reader skips. The earlier records are the ones a crash report needs.
    expect(lines[0]! + "\n").toBe(line(0))
    expect(lines[1]! + "\n").toBe(line(1))
    expect(lines[2]!.startsWith("timestamp=torn")).toBe(true)
    expect(lines[2]!.endsWith("tail=yes")).toBe(false) // torn, as designed
    expect(writer.available).toBe(false)
  })
})

describe("the short-lived CLI flushes — the filed defect, closed", () => {
  test("a process that exits inside the scope still writes its lines; Logger.toFile writes none", async () => {
    await using dir = await tmpdir()
    const writerFile = path.join(dir.path, "novaclaw.log")
    const controlFile = path.join(dir.path, "control.log")
    const fixture = path.join(import.meta.dir, "..", "..", "test", "fixture", "log-flush-exit.ts")

    const child = Bun.spawn([process.execPath, fixture, writerFile, controlFile], {
      env: { ...process.env, NOVACLAW_PRINT_LOGS: "0" },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const reported = stdout.trim().split("\n").at(-1) ?? ""
    if (!reported.startsWith("{"))
      throw new Error(`the flush fixture printed no report (exit ${exitCode}).\n${stdout}\n${stderr}`)
    const before = JSON.parse(reported) as { writerBeforeExit: number; controlBeforeExit: number }

    expect(exitCode).toBe(0)
    // Both arms were still empty an instant before the exit — so what follows is a statement about
    // the exit path, not about one of them writing eagerly.
    expect(before.writerBeforeExit).toBe(0)
    expect(before.controlBeforeExit).toBe(0)

    // 🔴 The control, and the whole reason this test is a subprocess: `Logger.toFile` batches into a
    // `setTimeout` the process never reaches. This is the filed defect, reproduced.
    expect(fsSync.readFileSync(controlFile, "utf8")).toBe("")

    // The claim: the writer's `process.on("exit")` hook flushed synchronously.
    const written = fsSync.readFileSync(writerFile, "utf8")
    expect(written).toContain('message="flush-on-exit probe"')
    expect(written).toContain("run=exitrun")
    expect(written.endsWith("\n")).toBe(true)
  })
})

describe("design principle 11 — where the bytes land on a machine that is not this one", () => {
  test("the log directory is inside the instance home and is never the drive root", () => {
    const data = Global.Path.data.replaceAll("\\", "/")
    const log = Global.Path.log.replaceAll("\\", "/")
    expect(log.startsWith(data)).toBe(true)
    // A root-anchored path resolves against the process's CURRENT DRIVE — the measured exception in
    // AGENTS.md principle 11. A one-segment log root IS the drive root and is the bug this pins.
    expect(log.split("/").filter(Boolean).length).toBeGreaterThan(1)
  })

  test("a writer puts every segment beside its active file and nowhere else", async () => {
    await using dir = await tmpdir()
    const home = path.join(dir.path, "home", "log")
    const file = path.join(home, "novaclaw.log")
    const writer = LogFile.open({ file, segmentBytes: 200 })
    for (let index = 0; index < 20; index++) writer.write(line(index), true)
    await writer.idle()
    writer.close()

    // Directory creation is the writer's, and it is `recursive` — but it must not reach outward.
    expect(fsSync.readdirSync(path.join(dir.path, "home"))).toEqual(["log"])
    expect(names(home).every((entry) => entry.startsWith("novaclaw"))).toBe(true)
    expect(fsSync.readdirSync(dir.path).sort()).toEqual(["home"])
  })
})
