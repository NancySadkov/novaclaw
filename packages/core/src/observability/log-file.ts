export * as LogFile from "./log-file"

import fsSync from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

/**
 * **The log writer: one active segment, gzipped rotations, a bounded directory.**
 *
 * ⭐ **The sidecar owns its own segments**, rather than delegating to `electron-log`: that library
 * only exists in the desktop app, and the headless instance is the one whose logs matter most.
 *
 * ── THE RULE, and why this module has no error channel ──────────────────────────────────────────
 *
 * 🔴 **Logging must never take the instance down** — it is the one subsystem you most need when a
 * boot is failing, so an unwritable `<data>/log` must not be able to kill the boot. That is why
 * `observability.ts` carries no `Layer.orDie` over the file logger: an `orDie` over an error channel
 * of `PlatformError` is exactly how the rule was broken once.
 *
 * This module is built so that cannot be undone by accident: **no function here fails.** Every
 * syscall is inside a `try`, a failure sets {@link Writer.state} to `unavailable`, names itself once
 * on stderr, and the lines keep flowing to stderr. There is nothing to `orDie` over, because there
 * is no error channel to widen.
 *
 * ── why not `Logger.toFile` ─────────────────────────────────────────────────────────────────────
 *
 * It is the source of three defects at once and only one of them is the type:
 *
 * 1. **It owns the file descriptor** (`flag: "a+"`), so nothing outside it can rotate safely. The
 *    writer must own rotation — close, rename, reopen, **in that order** — which means owning the
 *    handle.
 *
 *    ⚠️ **The hazard is a SILENT rename, not a loud `EPERM`** — and do not "simplify" the ordering
 *    on the belief that Windows refuses the rename. It does not: measured 2026-08-07 on win32 +
 *    bun 1.3.14, `fs.renameSync` **succeeded** with the writer's own append handle open and again
 *    with a second reader handle open, because libuv passes `FILE_SHARE_DELETE`. What actually goes
 *    wrong is that the rename succeeds and the open descriptor FOLLOWS the file to its new name, so
 *    every line written after an external rotation lands **inside the sealed, about-to-be-gzipped
 *    segment** while the fresh `novaclaw.log` stays empty. An error you can see would be the better
 *    failure. Close-before-rename is correct on every platform, and `log-file.test.ts` proves the
 *    unguarded twin loses the bytes on this one.
 * 2. **Its error channel is `PlatformError`** — the boot-killer above.
 * 3. 🔴 **It batches into a `setTimeout` a short-lived process never reaches.** `novaclaw.log` was
 *    empty for the CLI entry point, for *every* event, while a long-lived `serve` flushed fine. A
 *    log nobody can read after a crash is the same defect as the crash-telemetry packet that is
 *    issued and then lost because the process exits first. Closed here by writing SYNCHRONOUSLY
 *    from a `process.on("exit")` hook — see {@link Writer.flush}.
 *
 * ── the filename grammar IS the contract (§0.7) ─────────────────────────────────────────────────
 *
 *   `novaclaw.log`                            the active segment — **never compressed**
 *   `novaclaw-20260807T221314123Z.log.gz`     a rotated segment
 *   `novaclaw-20260807T221314123Z.log.gz.tmp` a gzip in flight (swept)
 *
 * The stamp is fixed-width and colon-free, so **lexicographic order is chronological order** (the
 * `trash.ts` date-dir trick) and the name is legal on Windows, where `:` is not. A naive miner needs
 * exactly `ls`, `grep` and `zgrep` — no bespoke parser, no `jq`, and nothing to install: gzip was
 * chosen over zstd because `zstdgrep` is not on this machine while `zgrep` is (§0.5, measured).
 *
 * ⚠️ **The stamp, not `mtime`, is the age.** A backup, a copy into a bug report, or a restore
 * rewrites mtime and cannot rewrite the name.
 *
 * ── the bound, stated (because an unbounded log directory is what people uninstall) ─────────────
 *
 * {@link SEGMENT_BYTES} active · {@link TOTAL_BYTES} across the whole directory · {@link MAX_AGE_MS}
 * maximum age. The byte budget is enforced over the DIRECTORY, active segment included, so the
 * ceiling is `TOTAL_BYTES` plus at most one segment in flight and never more. Both limits are
 * needed and neither alone works: age alone lets one debug session fill the disk in a day, size
 * alone throws away a quiet instance's only history (§2d).
 *
 * ── retention is NOT a fifth daemon (§0.9) ──────────────────────────────────────────────────────
 *
 * Four uncoordinated sweeps already exist (tool-output spill 7 d, jh attempt workspaces 3 d, Trash,
 * jh row TTL) and every one of them converged independently on the same shape: **lazy, on the write
 * path, no timer**. For logs it is cleaner still, because **rotation is itself a write event** — the
 * sweep runs when a segment closes and never otherwise, so a quiet instance does no work and there
 * is no timer to leak.
 */

/**
 * ~14 weeks of normal use at the **measured 83 KB/day** (`LogRead.usage`, this machine, 2026-08-08 —
 * the 69.5 KB/day this line used to cite is 2026-07-29's, and the file has since been re-measured
 * twice at 134 and 83); ~500 KB gzipped (§0.5). A correctness parameter, not a preference (3c) —
 * which is why it is here and not in `log-bounds.ts`.
 */
export const SEGMENT_BYTES = 8 * 1024 * 1024
/**
 * The two bounds a product surface may name, declared in a leaf module with no Node imports so a
 * Settings panel can say the number instead of retyping it. See `log-bounds.ts` for what each one
 * actually promises — age and bytes are independent ceilings, so heavy traffic may evict a segment
 * before the age window while quiet traffic may keep the active segment longer.
 */
export { TOTAL_BYTES, MAX_AGE_MS } from "./log-bounds"
import { MAX_AGE_MS, TOTAL_BYTES } from "./log-bounds"
import { LogSettings } from "./log-settings"
import { escapeRegExp } from "@novaclaw/schema/text"
/** Effect's own default. ⚠️ Do not lower it toward 0 — that burns idle CPU (§0.5). */
export const FLUSH_MS = 1000
/** Flush early when the buffer gets big, so a burst cannot hold a megabyte of lines hostage. */
export const BUFFER_BYTES = 64 * 1024
/**
 * When rotation is BLOCKED (a reader holds the file open on Windows), the active segment is
 * truncated once it passes this multiple of the segment size. Without it "bounded by construction"
 * would be a hope: a single stuck `tail -f` would let the active file grow forever. This is
 * electron-log's `crop` fallback and it is the reason the bound above is mechanical.
 */
export const ROTATION_STUCK_MULTIPLE = 2
/** A `.tmp` older than this is abandoned work (a crash mid-gzip), not a peer's gzip in flight. */
export const TMP_GRACE_MS = 5 * 60 * 1000

/** `2026-08-07T22:13:14.123Z` → `20260807T221314123Z`: fixed width, colon-free, sorts. */
export const stampOf = (date: Date): string =>
  date.toISOString().replaceAll("-", "").replaceAll(":", "").replace(".", "")

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/

/** The epoch millis a segment stamp names, or `undefined` if the name is not one of ours. */
export function timeOfStamp(stamp: string): number | undefined {
  const parts = STAMP.exec(stamp)
  if (!parts) return undefined
  const [, year, month, day, hour, minute, second, millis] = parts as unknown as string[]
  return Date.UTC(+year!, +month! - 1, +day!, +hour!, +minute!, +second!, +millis!)
}

export interface Segment {
  readonly file: string
  readonly stamp: string
  /** Epoch millis, read from the NAME. */
  readonly time: number
  readonly compressed: boolean
  readonly bytes: number
}

const sizeOf = (file: string): number => {
  try {
    return fsSync.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * Every rotated segment in `directory` for the active file `<name>.log`, oldest first.
 *
 * Exported because it is the READER's half of the filename grammar: the desktop export, the Debug
 * app and any future reader walk this, not a private field. Never throws — an unreadable directory
 * is an empty list, which is the honest answer for a retention sweep.
 */
export function segmentsIn(directory: string, name: string): Segment[] {
  const pattern = new RegExp(`^${escapeRegExp(name)}-(\\d{8}T\\d{9}Z)\\.log(\\.gz)?$`)
  let entries: string[]
  try {
    entries = fsSync.readdirSync(directory)
  } catch {
    return []
  }
  const segments: Segment[] = []
  for (const entry of entries) {
    const match = pattern.exec(entry)
    if (!match) continue
    const time = timeOfStamp(match[1]!)
    if (time === undefined) continue
    const file = path.join(directory, entry)
    segments.push({ file, stamp: match[1]!, time, compressed: match[2] !== undefined, bytes: sizeOf(file) })
  }
  return segments.sort((a, b) => a.stamp.localeCompare(b.stamp))
}

/** A file in the log directory that this writer's grammar does not own. */
export interface Residue {
  readonly file: string
  /** Epoch millis, read from `mtime` — residue carries no stamp in its name to read instead. */
  readonly time: number
  readonly bytes: number
}

/**
 * Everything in `directory` that is neither the active `<name>.log` nor one of its rotated segments,
 * oldest first.
 *
 * 🔴 This is the OTHER half of the retention grammar, and it exists because the first half was a
 * whitelist. `segmentsIn` answers "which files are mine"; a byte ceiling that claims to bound a
 * DIRECTORY needs the complement too, or anything a second writer drops here is uncounted and
 * unbounded forever. The measured case is the auto heap snapshot (`novaclaw/src/cli/heap.ts`), which
 * lands in `Global.Path.log` at RSS size — gigabytes — and matched neither the segment pattern nor
 * the `.gz.tmp` pattern, so retention neither deleted it nor added it to the total it enforces.
 *
 * ⚠️ By `mtime`, not by a stamp: residue by definition does not speak this module's filename
 * grammar, so there is nothing in the name to read. That is weaker than a segment's stamp (a restore
 * rewrites mtime) and it is the strongest signal available — and it is only ever used to decide
 * eviction ORDER and expiry, never to date a log line.
 *
 * ⚠️ Never throws — an unreadable directory is an empty list, the same honest answer `segmentsIn`
 * gives. Directories and anything unstattable are skipped rather than guessed at.
 */
export function residueIn(directory: string, name: string): Residue[] {
  const segment = new RegExp(`^${escapeRegExp(name)}-\\d{8}T\\d{9}Z\\.log(\\.gz)?$`)
  const active = `${name}.log`
  let entries: string[]
  try {
    entries = fsSync.readdirSync(directory)
  } catch {
    return []
  }
  const residue: Residue[] = []
  for (const entry of entries) {
    if (entry === active || segment.test(entry)) continue
    const file = path.join(directory, entry)
    try {
      const stat = fsSync.statSync(file)
      if (!stat.isFile()) continue
      residue.push({ file, time: stat.mtimeMs, bytes: stat.size })
    } catch {
      continue
    }
  }
  return residue.sort((a, b) => a.time - b.time)
}

/**
 * **When the ACTIVE segment's own first line was written**, or `undefined` when the file is empty,
 * unreadable, or its first line is not one of ours.
 *
 * ⚠️ Read from the FIRST LINE rather than from `mtime`, for the reason this module's header gives
 * about segment stamps: a backup, a copy into a bug report, or a restore rewrites mtime and cannot
 * rewrite what the bytes say.
 *
 * ⚠️ This lives here rather than in `log-read.ts` because it is the WRITER's own file format, and
 * because the writer needs it — {@link Writer.rotate} is age-driven as well as size-driven. Putting
 * it in the reader and importing it back would be a cycle; putting a second copy in each would be
 * the one-description-twice defect. `log-read.ts` imports this one.
 */
export function firstLineTime(file: string): number | undefined {
  try {
    const size = fsSync.statSync(file).size
    if (size === 0) return undefined
    const handle = fsSync.openSync(file, "r")
    try {
      const want = Math.min(size, 8192)
      const buffer = Buffer.allocUnsafe(want)
      fsSync.readSync(handle, buffer, 0, want, 0)
      const text = buffer.toString("utf8")
      const newline = text.indexOf("\n")
      // A first line longer than the window is damage, not data — say nothing rather than parse half
      // a line into a confident timestamp.
      if (newline === -1 && size > want) return undefined
      const line = newline === -1 ? text : text.slice(0, newline)
      const stamp = /(?:^|\s)timestamp=("[^"]*"|\S+)/.exec(line)?.[1]
      if (stamp === undefined) return undefined
      const parsed = Date.parse(stamp.startsWith('"') ? stamp.slice(1, -1) : stamp)
      return Number.isNaN(parsed) ? undefined : parsed
    } finally {
      fsSync.closeSync(handle)
    }
  } catch {
    return undefined
  }
}

/** `ok` until something refuses; then `unavailable`, named, and every line goes to stderr. */
export type State = { readonly kind: "ok" } | { readonly kind: "unavailable"; readonly reason: string }

export interface Options {
  /** The ACTIVE segment. Its directory and basename derive the whole grammar. */
  readonly file: string
  readonly segmentBytes?: number
  readonly totalBytes?: number
  readonly maxAgeMs?: number | (() => number)
  readonly flushMs?: number
  readonly now?: () => Date
  /** Test seam AND the fault injector for a failing compression. */
  readonly compress?: (input: Buffer) => Buffer | Promise<Buffer>
  /** Test seam: the raw append. Lets a test make the disk full at an exact byte. */
  readonly appendFn?: (fd: number, chunk: Buffer) => void
  /** Test seam: rename, so the Windows `EBUSY` rotation block is reproducible on any OS. */
  readonly renameFn?: (from: string, to: string) => void
  /**
   * Test seam: the hard-cap truncation. It exists because the branch it guards is the one whose
   * failure is swallowed — and a swallowed failure whose recovery path nothing exercises is a claim
   * with no evidence, which is how the `ftruncateSync` EPERM shipped green in the first place.
   */
  readonly truncateFn?: (file: string) => void
  /** Called once, when the writer degrades. `logging.ts` owns the user-facing wording. */
  readonly onDegrade?: (reason: string, file: string) => void
  /**
   * True when this run already mirrors every line to stderr (`NOVACLAW_PRINT_LOGS=1`). The
   * degraded fallback then writes nothing, because stderr already has the line and doubling it is
   * the exact defect `stderrLogger`'s shared identity exists to prevent.
   */
  readonly mirrored?: boolean
}

const gzip = (input: Buffer): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    // -6, not -9: §0.5 measured -9 buying ~3% on this corpus for noticeably more CPU.
    zlib.gzip(input, { level: 6 }, (error, output) => (error ? reject(error) : resolve(output))),
  )

/**
 * Every live writer, flushed synchronously from ONE `process.on("exit")` hook.
 *
 * 🔴 This is the fix for a measured defect: `Logger.toFile` batches into a
 * `setTimeout`, so a short-lived CLI exits before the batch window and `novaclaw.log` was empty for
 * that entry point for every event. Measured on bun 1.3.14: an `exit` handler DOES run on
 * `process.exit(0)`, and `fs.writeSync` inside one lands — which is why {@link Writer.flush} is
 * synchronous and why nothing on the flush path awaits.
 *
 * ⚠️ `bun test` does NOT run `exit` handlers (AGENTS.md pitfall #8), so the test for this spawns a
 * real child process rather than asserting on the hook in-process.
 */
const live = new Set<Writer>()
let hooked = false
function hookExit() {
  if (hooked) return
  hooked = true
  process.on("exit", () => {
    for (const writer of live) writer.flush()
  })
}

export class Writer {
  readonly file: string
  readonly directory: string
  readonly name: string

  private readonly options: Options
  private readonly segmentBytes: number
  private readonly totalBytes: number
  private readonly maxAgeMs: () => number
  private readonly flushMs: number
  private readonly now: () => Date

  private fd: number | undefined
  private size = 0
  /**
   * When the active segment's oldest line was written — the denominator of the AGE rotation below.
   * `undefined` means "nothing readable in it yet"; the first successful append adopts `now`.
   */
  private activeSince: number | undefined
  private buffer: string[] = []
  private buffered = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private work: Promise<void> = Promise.resolve()

  state: State = { kind: "ok" }
  /** Lines that never reached the file because the writer was already degraded. */
  dropped = 0
  rotations = 0
  /**
   * Rotation attempts the filesystem refused — a permission error, an antivirus lock, or a reader
   * that opened without share-delete. ⚠️ NOT the `EPERM` §0.10 predicts for a plain open handle:
   * that was measured and does not happen (see this module's header).
   */
  rotationsBlocked = 0
  /** Times the active segment was truncated because rotation stayed blocked past the hard cap. */
  truncations = 0
  /**
   * Rotations triggered by AGE rather than by size. Counted separately because the two answer
   * different questions and the age one is the newer, load-bearing half — see {@link rotate}.
   */
  rotationsByAge = 0

  constructor(options: Options) {
    this.options = options
    this.file = options.file
    this.directory = path.dirname(options.file)
    this.name = path.basename(options.file).replace(/\.log$/, "")
    this.segmentBytes = options.segmentBytes ?? SEGMENT_BYTES
    this.totalBytes = options.totalBytes ?? TOTAL_BYTES
    const configuredMaxAge = options.maxAgeMs
    this.maxAgeMs =
      typeof configuredMaxAge === "function" ? configuredMaxAge : () => configuredMaxAge ?? LogSettings.maxAgeMs()
    this.flushMs = options.flushMs ?? FLUSH_MS
    this.now = options.now ?? (() => new Date())
    this.open()
    if (this.state.kind === "ok") {
      live.add(this)
      hookExit()
      // 🔴 **NEITHER rotation NOR the sweep makes "30 days" a CEILING — it is a retention FLOOR,
      // and the Settings row must keep saying "at least" (`log-bounds.ts`).** `sweep()` can only
      // delete ROTATED segments; the active one is never a candidate. At the measured ~83 KB/day an
      // 8 MB segment closes about every 14 weeks, so a merely *quiet* instance keeps its whole
      // history in the one file no sweep can reach — measured 2026-08-08, `LogRead.usage` over both
      // of this machine's real log directories reported `segments: 0`, i.e. neither had ever
      // rotated. Same shape `trash.ts` states honestly about its own TTL.
      //
      // What IS true, and is the reason both mechanisms stay: **nothing newer than the age limit is
      // ever deleted, and the byte ceiling is real** — it totals the whole directory, and the active
      // segment is separately hard-capped by `ROTATION_STUCK_MULTIPLE`. Making the 30 days a real
      // ceiling means changing the rotation policy, which carries a genuine granularity trade-off;
      // do it deliberately, not by tightening a number here.
      //
      // Opening the log IS a write event, so the sweep rides it. This is deliberately the same
      // launch-triggered pattern §0.6 identified in electron-log and told us to copy: no daemon, no
      // timer, and an instance nobody starts does no work. Total by construction (`sweep` cannot
      // throw), and it is a `readdir` plus a `stat` over a few dozen entries — startup speed is
      // first-class, and this is not where it goes.
      //
      // ⭐ **AGE ROTATION, and it is the half that makes the sweep able to do anything at all.** An
      // instance that has been closed for two months reopens with a two-month-old active segment;
      // seal it here so it becomes a candidate, rather than waiting for it to reach 8 MB. This runs
      // BEFORE the sweep so the segment it just sealed is considered in the same pass.
      if (this.tooOld()) this.rotate()
      this.sweep()
    }
  }

  get available(): boolean {
    return this.state.kind === "ok"
  }

  private open(): void {
    try {
      fsSync.mkdirSync(this.directory, { recursive: true })
      this.fd = fsSync.openSync(this.file, "a")
      this.size = sizeOf(this.file)
      // Read BEFORE anything is appended, so a segment inherited from an earlier run is aged from
      // its own oldest line rather than from this process's start — otherwise every restart would
      // reset the clock and a frequently restarted instance would never age-rotate at all.
      this.activeSince = firstLineTime(this.file)
    } catch (cause) {
      this.degrade(cause instanceof Error ? cause.message : String(cause))
    }
  }

  /** True when the active segment has been open longer than the retention age. */
  private tooOld(): boolean {
    return this.activeSince !== undefined && this.now().getTime() - this.activeSince >= this.maxAgeMs()
  }

  /**
   * The one place this module gives up, and it gives up LOUDLY and exactly once.
   *
   * ⚠️ The warning goes to `console.error`, not through `Log.event`/`Effect.log*`, and that is not
   * an exemption from the keyed-log rule: this IS the log sink, so logging about it would either
   * recurse or vanish into the thing that just failed. Same shape `logging.ts` and `global.ts`
   * already use for a failure that happens below the logger.
   */
  private degrade(reason: string): void {
    if (this.state.kind === "unavailable") return
    this.state = { kind: "unavailable", reason }
    this.closeFd()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    live.delete(this)
    // The pending lines are not lost silently — they go where the rest of the run's lines will go.
    const pending = this.buffer.join("")
    this.buffer = []
    this.buffered = 0
    if (pending && !this.options.mirrored) process.stderr.write(pending)
    this.options.onDegrade?.(reason, this.file)
  }

  private closeFd(): void {
    if (this.fd === undefined) return
    try {
      fsSync.closeSync(this.fd)
    } catch {
      // Nothing useful to do with a failing close; the handle is going away with the process.
    }
    this.fd = undefined
  }

  /**
   * Buffer one already-formatted line. **Returns false when the file leg is dead**, which is the
   * caller's cue to write the line to stderr instead — a continuous degrade, not a one-shot check
   * at boot, because a disk fills up mid-run.
   *
   * `immediate` is the *error and above* durability rule from the defaults table: the lines you
   * most need after a crash do not wait out a batch window.
   */
  write(line: string, immediate = false): boolean {
    if (this.state.kind === "unavailable") {
      this.dropped++
      return false
    }
    this.buffer.push(line)
    this.buffered += Buffer.byteLength(line, "utf8")
    if (immediate || this.buffered >= BUFFER_BYTES) {
      // A flush can degrade — so the answer this returns must be read AFTER it, through the getter
      // (see `rotate`). Getting this wrong would report a write as accepted that went nowhere.
      this.flush()
      return this.available
    }
    if (this.timer === undefined) {
      this.timer = setTimeout(() => {
        this.timer = undefined
        this.flush()
      }, this.flushMs)
      // ⚠️ A referenced timer would keep a short-lived CLI alive for a second after its work is
      // done — the logger deciding the process's lifetime. Never.
      this.timer.unref?.()
    }
    return true
  }

  /**
   * Write the buffer out, synchronously. Safe to call from a `process.on("exit")` hook — that is
   * the whole reason it is `writeSync` and not a stream.
   */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    if (this.buffer.length === 0) return
    // ⚠️ A missing handle while the state still says `ok` is an invariant violation, and the
    // tempting `return` here is a SILENT one: the buffer would grow in memory forever and every
    // line would be lost with nothing said. Name it and degrade — the lines then go to stderr,
    // which is the whole contract of this module.
    if (this.fd === undefined) {
      this.degrade("the log file handle was lost")
      return
    }
    const chunk = Buffer.from(this.buffer.join(""), "utf8")
    this.buffer = []
    this.buffered = 0
    try {
      const append = this.options.appendFn ?? defaultAppend
      append(this.fd, chunk)
      this.size += chunk.length
      // A segment whose first line we could not read (a fresh file, or a damaged head) still has to
      // age from somewhere, or it would never rotate on age at all.
      this.activeSince ??= this.now().getTime()
    } catch (cause) {
      // Put the lines back so `degrade` can spill them, then give up on the file for this run.
      this.buffer = [chunk.toString("utf8")]
      this.degrade(cause instanceof Error ? cause.message : String(cause))
      return
    }
    if (this.size >= this.segmentBytes || this.tooOld()) this.rotate()
  }

  /**
   * Close the active segment and open a fresh one. **close → rename → reopen, in that order.**
   *
   * ⚠️ The order is load-bearing for the reason measured in this module's header, which is NOT the
   * `EPERM`/`EBUSY` the design sketch predicted: on win32 the rename SUCCEEDS with the handle open, and the
   * handle follows the file — so every subsequent line lands in the sealed segment and the fresh
   * `novaclaw.log` stays empty. Silent, not loud.
   *
   * A rename that fails anyway (a reader holds the file) is not an error: keep writing the active
   * segment and try again next flush. {@link ROTATION_STUCK_MULTIPLE} is what stops that becoming
   * unbounded growth.
   *
   * ── ⭐ rotation is driven by AGE as well as by SIZE, and the measurement is why ─────────────────
   *
   * This module shipped size-only, with {@link SEGMENT_BYTES} chosen against *"the measured
   * 69.5 KB/day"*. `LogRead.usage` — the Phase-3 event that exists precisely to re-derive those
   * numbers — measured this machine's two real log directories on 2026-08-08 and reported **83
   * KB/day** and **32 KB/day**, both with **`segments: 0`**. Neither had ever rotated, so on both of
   * them every retention mechanism in this file was inert: `sweep` only ever considers ROTATED
   * segments, and there were none. The 30-day number in a Settings row was describing behaviour that
   * could not happen for another ~99 days on one directory and ~256 on the other.
   *
   * ⭐ **The generalisable fault is not the number, it is the SHAPE.** A size threshold makes the
   * retention promise a function of the write rate — and the write rate is the one thing that
   * measurement showed to be unstable: 69.5 → 134 → 83 KB/day on one file over nine days, and 2.6×
   * apart between two directories on the same machine on the same day. Any single byte figure would
   * have been wrong for somebody. An AGE threshold is rate-independent: a segment closes when it has
   * been open for {@link MAX_AGE_MS} no matter how fast or slow it filled, so the sweep always has
   * something to sweep. That is why the fix is a second trigger rather than a smaller
   * {@link SEGMENT_BYTES} — a smaller byte figure would be the same mistake with better luck.
   *
   * ⚠️ **What it now promises, exactly.** A line is sealed at latest `MAX_AGE_MS` after its
   * segment's first line, and a sealed segment is deleted `MAX_AGE_MS` after being sealed — so
   * **nothing newer than 30 days is deleted, and nothing older than ~60 days survives**. The floor
   * is the number the product says; the ceiling is new, and before this change there was none.
   */
  rotate(): void {
    if (this.state.kind === "unavailable") return
    const byAge = this.tooOld()
    this.closeFd()
    const target = this.freeTarget()
    let renamed = true
    try {
      const rename = this.options.renameFn ?? fsSync.renameSync
      rename(this.file, target)
    } catch {
      renamed = false
      this.rotationsBlocked++
    }
    this.open()
    // `this.available` rather than `this.state.kind`: `open()` can degrade, and TypeScript's
    // narrowing from the guard at the top of this method does not know that. Reading through the
    // getter is what makes the re-check real instead of a comparison the compiler folds away.
    if (!this.available) return
    if (!renamed) {
      // The bound is mechanical or it is not a bound: a stuck reader must not buy unlimited growth.
      if (this.size >= this.segmentBytes * ROTATION_STUCK_MULTIPLE) {
        // ⚠️ **`ftruncateSync` on an append-mode descriptor throws `EPERM` on win32** (measured
        // 2026-08-07, bun 1.3.14): a handle opened `"a"` has no write access for `SetEndOfFile`.
        // The first version of this branch did exactly that, and the failure was SILENT — the
        // `catch` swallowed it, `truncations` stayed 0, and the "bounded by construction" claim was
        // false on the one platform this ships on most. Truncate by PATH instead, which needs the
        // handle closed first and works everywhere.
        //
        // ⚠️ The reopen is OUTSIDE the `try` on purpose. With it inside, a refused truncate left
        // the writer holding no handle while its state still said `ok` — every later line silently
        // dropped, no warning, nothing degraded. A cleanup that only runs on the happy path is not
        // cleanup.
        this.closeFd()
        let truncated = false
        try {
          const truncate = this.options.truncateFn ?? ((file: string) => fsSync.truncateSync(file, 0))
          truncate(this.file)
          truncated = true
        } catch {
          // Even truncation refused. Nothing here is worth crashing the instance over.
        }
        this.open()
        if (!this.available) return
        if (truncated) {
          this.size = 0
          this.truncations++
          process.stderr.write(
            `[novaclaw] WARNING: ${this.file} could not be rotated (something else is holding it ` +
              `open) and passed its hard cap, so it was truncated. Earlier lines from this run are gone.\n`,
          )
        }
      }
      return
    }
    this.rotations++
    if (byAge) this.rotationsByAge++
    // `open()` above re-read the (now empty) file, so `activeSince` is already `undefined` and the
    // fresh segment ages from its own first line. Stated because forgetting it would leave the
    // writer rotating on every flush forever, which is the loudest possible version of this bug and
    // still one nothing would fail on.
    // Compression and the retention sweep are the only things here that are not on the hot path.
    // `zlib.gzip` runs on the libuv threadpool; a crash before it finishes leaves the plain `.log`,
    // which is still greppable and still swept.
    this.work = this.work.then(() => this.compressAndSweep(target)).catch(() => {})
  }

  /** A rotated name nobody has taken. Bumps by a millisecond rather than adding a counter, so the
   *  grammar stays single and lexicographic order stays chronological. */
  private freeTarget(): string {
    let time = this.now().getTime()
    for (let attempt = 0; attempt < 1000; attempt++) {
      const target = path.join(this.directory, `${this.name}-${stampOf(new Date(time))}.log`)
      if (!fsSync.existsSync(target) && !fsSync.existsSync(`${target}.gz`)) return target
      time++
    }
    return path.join(this.directory, `${this.name}-${stampOf(new Date(time))}.log`)
  }

  private async compressAndSweep(segment: string): Promise<void> {
    await this.compressSegment(segment)
    this.sweep()
  }

  /**
   * gzip a rotated segment in place: `<seg>.log` → `<seg>.log.gz`.
   *
   * Via a `.tmp` and a rename, so a crash mid-compression can never leave a truncated `.gz` that
   * `zcat` refuses. The two possible outcomes are both readable by a naive miner: the plain `.log`
   * (compression never finished) or the finished `.gz`.
   */
  private async compressSegment(segment: string): Promise<void> {
    const compress = this.options.compress ?? gzip
    const temporary = `${segment}.gz.tmp`
    try {
      const output = await compress(fsSync.readFileSync(segment))
      fsSync.writeFileSync(temporary, output)
      fsSync.renameSync(temporary, `${segment}.gz`)
      fsSync.rmSync(segment, { force: true })
    } catch {
      // The uncompressed segment stays. It costs disk and it is still a log — the retention sweep
      // bounds it either way, which is why this failure is not worth surfacing.
      try {
        fsSync.rmSync(temporary, { force: true })
      } catch {
        /* swept by `sweep()` on its grace period */
      }
    }
  }

  /**
   * Delete oldest-first past the byte budget AND past the age (§2d — both, because either alone
   * fails). The active segment is never a candidate.
   *
   * 🔴 **The budget is over the DIRECTORY, not over this writer's own grammar.** `log-bounds.ts`
   * says the ceiling "totals the whole directory", and until this pass existed it did not: it
   * totalled the files matching `<name>-<stamp>.log(.gz)`. Anything else written into
   * `<data>/log` — the auto heap snapshot is the measured case, an RSS-sized file holding every live
   * string in the process — was invisible to BOTH halves of retention. Never deleted by age, never
   * deleted by budget, and not counted in the total the ceiling is compared against, so a Settings
   * row kept telling the user the log directory was capped at 256 MB beside gigabytes it did not
   * know about.
   *
   * ⚠️ Fixed as a CLASS rather than by teaching the sweep one more filename: residue is *everything*
   * that is not the active file and not a rotated segment, so the next writer that drops a file here
   * is counted and bounded without anybody remembering to come back. Two consequences are
   * deliberate: residue is evicted BEFORE segments (a diagnostic artefact is scratch; the rotated
   * log is the record, and one 4 GB snapshot must not evict a year of history to get under budget),
   * and nothing inside {@link TMP_GRACE_MS} of now is touched — the same grace, for the same reason,
   * as the abandoned-gzip loop below: two instances can share one home and therefore one log
   * directory, and a peer's write in flight is not litter.
   *
   * Returns bytes freed. Never throws: a retention sweep that can fail a log write would be the
   * housekeeping-breaks-the-user's-operation shape `trash.ts` already refused.
   */
  sweep(): number {
    let freed = 0
    try {
      const cutoff = this.now().getTime() - this.maxAgeMs()
      const segments = segmentsIn(this.directory, this.name)
      const residue = residueIn(this.directory, this.name)
      let total =
        segments.reduce((sum, segment) => sum + segment.bytes, 0) +
        residue.reduce((sum, entry) => sum + entry.bytes, 0) +
        sizeOf(this.file)
      for (const entry of residue) {
        const expired = entry.time < cutoff
        const overBudget = total > this.totalBytes
        if (!expired && !overBudget) break
        // In flight, not litter — a peer instance may be writing it right now.
        if (this.now().getTime() - entry.time < TMP_GRACE_MS) continue
        try {
          fsSync.rmSync(entry.file, { force: true })
        } catch {
          continue
        }
        total -= entry.bytes
        freed += entry.bytes
      }
      for (const segment of segments) {
        const expired = segment.time < cutoff
        const overBudget = total > this.totalBytes
        if (!expired && !overBudget) break
        try {
          fsSync.rmSync(segment.file, { force: true })
        } catch {
          continue
        }
        total -= segment.bytes
        freed += segment.bytes
      }
      // Abandoned gzip work from a crash. The grace period is what keeps this safe when two
      // instances share one home and therefore one log directory.
      for (const entry of fsSync.readdirSync(this.directory)) {
        if (!entry.startsWith(`${this.name}-`) || !entry.endsWith(".gz.tmp")) continue
        const file = path.join(this.directory, entry)
        try {
          if (this.now().getTime() - fsSync.statSync(file).mtimeMs < TMP_GRACE_MS) continue
          const bytes = sizeOf(file)
          fsSync.rmSync(file, { force: true })
          freed += bytes
        } catch {
          continue
        }
      }
    } catch {
      // An unreadable log directory is not a reason to fail whatever triggered the sweep.
    }
    return freed
  }

  /**
   * Flush, close the handle, and stop being a candidate for the exit hook. Never throws.
   *
   * ⚠️ It also marks the writer unavailable — quietly, with no warning, because a clean close is
   * not a fault. That matters for a line logged AFTER the scope closed (shutdown ordering is not
   * something a logger gets to assume): without it such a line would be buffered into a writer
   * nothing will ever flush and lost in silence. Marked, it returns `false` and the sink puts it on
   * stderr, which is where a late shutdown line belongs anyway.
   */
  close(): void {
    this.flush()
    this.closeFd()
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    live.delete(this)
    if (this.state.kind === "ok") this.state = { kind: "unavailable", reason: "the log file was closed" }
  }

  /** Resolves when the deferred compression + sweep for every rotation so far has settled. */
  idle(): Promise<void> {
    return this.work
  }
}

function defaultAppend(fd: number, chunk: Buffer): void {
  // `writeSync` may write short. Looping is the difference between "usually fine" and correct.
  let offset = 0
  while (offset < chunk.length) offset += fsSync.writeSync(fd, chunk, offset, chunk.length - offset)
}

/** Open a writer. **Never throws** — inspect {@link Writer.available} instead. */
export const open = (options: Options): Writer => new Writer(options)

/**
 * How many writers are open right now.
 *
 * Exported as an OBSERVABLE, for the same reason {@link Writer.truncations} is: two writers on one
 * path is a real defect shape (two descriptors, two exit hooks, two rotation owners — the residual
 * this module's header names as its worst shared-directory case) and it is completely invisible from
 * the outside, because both of them append happily. `test/log-usage-boot.test.ts` reads this to prove
 * that the boot-time usage line — which needs the logger layer provided to it a second time — does
 * not build a second writer, and its negative control makes that number 2 on purpose.
 */
export const openWriters = (): number => live.size
