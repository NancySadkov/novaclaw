export * as LogFile from "./log-file"

import fsSync from "node:fs"
import path from "node:path"
import zlib from "node:zlib"

/**
 * **The log writer: one active segment, gzipped rotations, a bounded directory.**
 *
 * `todo/logging.md` Phase 2, §0.7 Option B — the sidecar owns its own segments, because
 * `electron-log` only exists in the desktop app and the headless instance is the one whose logs
 * matter most.
 *
 * ── THE RULE, and why this module has no error channel ──────────────────────────────────────────
 *
 * **Logging must never take the instance down.** That rule was violated until 2026-08-07:
 * `observability.ts` piped `Layer.orDie` over `Logger.toFile`, whose error channel is
 * `PlatformError`, so an unwritable `<data>/log` killed the boot — in the one subsystem you most
 * need when a boot is failing. `40223f295` fixed it by DELETING the `orDie` so the type holds the
 * channel empty.
 *
 * This module is built so that fix cannot be undone by accident: **no function here fails.** Every
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
 *    ⚠️ **`todo/logging.md` §0.10 justifies this with a "Windows rename trap" that DOES NOT
 *    REPRODUCE, measured 2026-08-07 on win32 + bun 1.3.14.** It claims *"Node does not open with
 *    `FILE_SHARE_DELETE` — so an external sweeper renaming `novaclaw.log` out from under the live
 *    writer will fail with `EPERM`/`EBUSY` on Windows"*. Probed both ways — the writer's own
 *    append handle open, and a second reader handle open — and `fs.renameSync` **succeeded** each
 *    time. libuv passes `FILE_SHARE_DELETE`.
 *
 *    ⭐ **The correction makes the rule stronger, not weaker, and it is what the test asserts.**
 *    The hazard is not a loud `EPERM`, it is a SILENT one: a rename succeeds and the open
 *    descriptor follows the file to its new name, so every line written after an external rotation
 *    lands **inside the sealed, about-to-be-gzipped segment** while the fresh `novaclaw.log` stays
 *    empty. An error you can see is a better failure than data in the wrong file. Close-before-
 *    rename is correct on every platform, and `log-file.test.ts` proves the unguarded twin loses
 *    the bytes on this one.
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
 * is no timer to leak. {@link Writer.reclaim} is the entry point the resource-pressure GC ladder
 * calls; this module deliberately grows no free-space probe of its own (ruling 6 — two measurements
 * of one fact).
 */

/** ~16 weeks of normal use at the measured 69.5 KB/day; ~500 KB gzipped (§0.5). */
export const SEGMENT_BYTES = 8 * 1024 * 1024
/** The ceiling that matters. Under sustained per-subsystem debug this is ~2–4 days of history. */
export const TOTAL_BYTES = 256 * 1024 * 1024
/** Matches Trash's decided retention, so the product tells the user ONE number. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
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

const escapeRegExp = (input: string) => input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

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

/** `ok` until something refuses; then `unavailable`, named, and every line goes to stderr. */
export type State = { readonly kind: "ok" } | { readonly kind: "unavailable"; readonly reason: string }

export interface Options {
  /** The ACTIVE segment. Its directory and basename derive the whole grammar. */
  readonly file: string
  readonly segmentBytes?: number
  readonly totalBytes?: number
  readonly maxAgeMs?: number
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
 * 🔴 This is the fix for the open defect in `todo/logging.md`: `Logger.toFile` batches into a
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
  private readonly maxAgeMs: number
  private readonly flushMs: number
  private readonly now: () => Date

  private fd: number | undefined
  private size = 0
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

  constructor(options: Options) {
    this.options = options
    this.file = options.file
    this.directory = path.dirname(options.file)
    this.name = path.basename(options.file).replace(/\.log$/, "")
    this.segmentBytes = options.segmentBytes ?? SEGMENT_BYTES
    this.totalBytes = options.totalBytes ?? TOTAL_BYTES
    this.maxAgeMs = options.maxAgeMs ?? MAX_AGE_MS
    this.flushMs = options.flushMs ?? FLUSH_MS
    this.now = options.now ?? (() => new Date())
    this.open()
    if (this.state.kind === "ok") {
      live.add(this)
      hookExit()
      // ⚠️ **Rotation alone does not make the 30-day promise true.** At the measured 69.5 KB/day an
      // 8 MB segment closes about every 16 weeks, so an instance that is merely *quiet* would keep
      // segments for months past the age limit — the "the TTL is a retention FLOOR, not a deadline"
      // shape `trash.ts` states honestly and this item cannot afford, because the number is going in
      // a Settings row that says *"keep about 30 days"*.
      //
      // Opening the log IS a write event, so the sweep rides it. This is deliberately the same
      // launch-triggered pattern §0.6 identified in electron-log and told us to copy: no daemon, no
      // timer, and an instance nobody starts does no work. Total by construction (`sweep` cannot
      // throw), and it is a `readdir` plus a `stat` over a few dozen entries — startup speed is
      // first-class, and this is not where it goes.
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
    } catch (cause) {
      this.degrade(cause instanceof Error ? cause.message : String(cause))
    }
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
    } catch (cause) {
      // Put the lines back so `degrade` can spill them, then give up on the file for this run.
      this.buffer = [chunk.toString("utf8")]
      this.degrade(cause instanceof Error ? cause.message : String(cause))
      return
    }
    if (this.size >= this.segmentBytes) this.rotate()
  }

  /**
   * Close the active segment and open a fresh one. **close → rename → reopen, in that order.**
   *
   * ⚠️ The order is load-bearing for the reason measured in this module's header, which is NOT the
   * one `todo/logging.md` §0.10 gives: on win32 the rename SUCCEEDS with the handle open, and the
   * handle follows the file — so every subsequent line lands in the sealed segment and the fresh
   * `novaclaw.log` stays empty. Silent, not loud.
   *
   * A rename that fails anyway (a reader holds the file) is not an error: keep writing the active
   * segment and try again next flush. {@link ROTATION_STUCK_MULTIPLE} is what stops that becoming
   * unbounded growth.
   */
  rotate(): void {
    if (this.state.kind === "unavailable") return
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
   * Returns bytes freed. Never throws: a retention sweep that can fail a log write would be the
   * housekeeping-breaks-the-user's-operation shape `trash.ts` already refused.
   */
  sweep(reclaimBytes = 0): number {
    let freed = 0
    try {
      const cutoff = this.now().getTime() - this.maxAgeMs
      const segments = segmentsIn(this.directory, this.name)
      let total = segments.reduce((sum, segment) => sum + segment.bytes, 0) + sizeOf(this.file)
      for (const segment of segments) {
        const expired = segment.time < cutoff
        const overBudget = total > this.totalBytes
        const owed = freed < reclaimBytes
        if (!expired && !overBudget && !owed) break
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
   * The entry point for the resource-pressure GC ladder (§0.9): free at least `bytes` of rotated
   * history, oldest first. Logs are OUR derived data, so rung 2 may reclaim them without asking —
   * ⚠️ unlike Trash, which the ladder may only ever ASK about.
   *
   * This module deliberately owns no free-space probe: how much pressure exists is the ladder's
   * measurement, and two measurements of one fact is what ruling 6 forbids.
   */
  reclaim(bytes: number): number {
    return this.sweep(bytes)
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
