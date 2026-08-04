export * as Pressure from "./pressure"

import { spawn, spawnSync } from "node:child_process"
import fs from "node:fs"
import nodePath from "node:path"
import { ResourcePressure } from "@novaclaw/schema/resource-pressure"
import { Schema } from "effect"

/**
 * ONE measurement of how much memory and disk this host has left.
 *
 * WHY THIS EXISTS. The product shipped blind: before this file, a grep across every package's `src` for
 * `freemem|totalmem|statfs|SystemCommitLimit|MemAvailable|Win32_OperatingSystem` returned ZERO hits.
 * NovaClaw had no idea how much memory or disk it had, on a machine that has twice been driven into
 * the ground by exactly that — a hard crash at 99.9% commit on 2026-07-20, and a false test failure at
 * 58 GB against a 44.7 GB limit on 2026-07-27 (AGENTS.md pitfalls #1 and #8b).
 *
 * WHY IT IS PLAIN TYPESCRIPT AND NOT AN EFFECT SERVICE. The only measurement that existed was the
 * dev-side `script/lib/heavy-guard.ts`, and todo.md ruling 6 says there is ONE gate, not two — two
 * measurements of the same fact is the divergence shape that produced the COMSPEC bug. heavy-guard is
 * a build script with no Effect runtime and a synchronous `check()`, so the shared primitive has to be
 * importable from a bare script. Hence: pure interpretation here, the Effect wrapper in `storage.ts`.
 *
 * ⚠️ COMMIT CHARGE, NEVER WORKING SET. On Windows we ask `Win32_OperatingSystem` for
 * TotalVirtualMemorySize/FreeVirtualMemory — the commit pair — because free RAM alarms fire far too
 * late or not at all: the box "works" at 99% commit for a day before dying. Those are the same two
 * fields heavy-guard reads, deliberately, so the Storage row and `Get-CimInstance Win32_OperatingSystem`
 * can never disagree (todo/resource-pressure.md ②: a number the operator cannot cross-check is worse
 * than no number). Every known reading carries the exact command that reproduces it.
 *
 * ⚠️ UNKNOWN IS A VALUE, NOT A ZERO (todo.md ruling 2 — a fault is never described falsely). A host we
 * cannot measure returns `{known: false, reason}`. It must never return 0 bytes free, because "0 bytes
 * free" reads as "the disk is full" and would make every consumer refuse work on a healthy machine.
 * `packages/novaclaw/test/config/resource-pressure.test.ts` pins that, negative-controlled.
 */

// ── readings ────────────────────────────────────────────────────────────────────────────────────

/** Where a memory number came from. Named, because the operator has to be able to re-run it. */
export type MemorySource = "windows-commit" | "linux-cgroup-v2" | "linux-cgroup-v1" | "linux-meminfo"

export interface MemoryKnown {
  readonly known: true
  readonly source: MemorySource
  /** The command or file the operator can read to get this same number. */
  readonly crosscheck: string
  readonly usedBytes: number
  readonly limitBytes: number
}
export interface Unavailable {
  readonly known: false
  /** Plain language, naming what is missing. Rendered to the operator as-is. */
  readonly reason: string
}
export type MemoryReading = MemoryKnown | Unavailable

export interface ProcessMemoryKnown {
  readonly known: true
  readonly rssBytes: number
  readonly crosscheck: string
}
export type ProcessMemoryReading = ProcessMemoryKnown | Unavailable

export interface DiskKnown {
  readonly known: true
  /** The instance path we were asked about. */
  readonly path: string
  /**
   * The path `statfs` actually answered for — `path` itself, or its nearest existing ancestor when the
   * instance directory has not been created yet. Same volume either way; recorded rather than hidden so
   * the number stays cross-checkable.
   */
  readonly measuredPath: string
  readonly freeBytes: number
  readonly totalBytes: number
}
export interface DiskUnavailable extends Unavailable {
  readonly path: string
}
export type DiskReading = DiskKnown | DiskUnavailable

/** `ok` < `warning` < `floor`; `unknown` is none of them and never collapses into `ok`. */
export type Level = "ok" | "warning" | "floor" | "unknown"

// ── thresholds ──────────────────────────────────────────────────────────────────────────────────

export interface Line {
  readonly memoryUsedFraction: number
  readonly diskFreeBytes: number
}
export interface Thresholds {
  readonly warning: Line
  readonly floor: Line
}

const GIB = 1024 ** 3

/**
 * The shipped lines, per-field fallbacks for the `resource_pressure` config key.
 *
 * `warning.memoryUsedFraction` is 0.75 ON PURPOSE: it is the identical number `heavy-guard.ts` uses as
 * `COMMIT_CEILING`, so the dev gate and the product agree about when this machine is uncomfortable
 * instead of drawing two lines a reader has to reconcile. The floor sits at 0.90 — the 2026-07-20 crash
 * was at 99.9% and the 2026-07-27 false failure at 130% of the limit, so 0.90 still leaves the room a
 * settle-and-flush needs.
 *
 * The disk lines are absolute: 2 GiB warns (a model download is multi-GB — `todo/sidecar-inference.md`),
 * 512 MiB floors (enough for a SQLite WAL checkpoint, a log flush and a session record to land rather
 * than tear).
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  warning: { memoryUsedFraction: 0.75, diskFreeBytes: 2 * GIB },
  floor: { memoryUsedFraction: 0.9, diskFreeBytes: 512 * 1024 * 1024 },
}

const decodeConfigured = Schema.decodeUnknownOption(ResourcePressure.Info)

/**
 * Where the lines in force came from.
 *
 * `invalid` exists so a malformed setting is REPORTED rather than silently swallowed: falling back to
 * the defaults is the safe behaviour, but doing it quietly would leave a user certain they had set a
 * floor they do not have — a failed mutation reporting success (ruling 2). The operator surface and the
 * on-demand resource detail report it; healthy ambient model context remains exception-only.
 */
export type ThresholdsSource = "default" | "config" | "invalid"

export interface ResolvedThresholds {
  readonly thresholds: Thresholds
  readonly source: ThresholdsSource
}

/**
 * Fold a stored `resource_pressure` value onto the defaults, FIELD BY FIELD.
 *
 * Per-field rather than per-object: a user who sets only a disk floor keeps the shipped memory line
 * instead of silently losing it, which is the same partial-override contract `tool_output` has.
 * A value that does not decode (hand-edited nonsense, a future shape) falls all the way back rather
 * than throwing — a malformed threshold must not be able to take the instance down, and the guard
 * staying at its default is the safe direction.
 */
export function resolveThresholds(stored: unknown): ResolvedThresholds {
  const decoded = stored === undefined ? undefined : decodeConfigured(stored)
  const value = decoded !== undefined && decoded._tag === "Some" ? decoded.value : undefined
  const line = (over: ResourcePressure.Level | undefined, base: Line): Line => ({
    memoryUsedFraction: over?.memory_used_fraction ?? base.memoryUsedFraction,
    diskFreeBytes: over?.disk_free_bytes ?? base.diskFreeBytes,
  })
  return {
    thresholds: {
      warning: line(value?.warning, DEFAULT_THRESHOLDS.warning),
      floor: line(value?.floor, DEFAULT_THRESHOLDS.floor),
    },
    source: decoded === undefined ? "default" : value === undefined ? "invalid" : "config",
  }
}

/** The top-level config key these thresholds live under. One name, so no caller spells it by hand. */
export const CONFIG_KEY = "resource_pressure"

// ── windows: commit charge ──────────────────────────────────────────────────────────────────────

/**
 * The single copy of the Windows probe. heavy-guard.ts holds a byte-identical script today; when it
 * adopts this module it imports these two instead of restating them.
 */
export const WINDOWS_COMMIT_ARGV = ["-NoProfile", "-NonInteractive", "-Command"] as const
export const WINDOWS_COMMIT_SCRIPT =
  "$os = Get-CimInstance Win32_OperatingSystem; " +
  "Write-Output (($os.TotalVirtualMemorySize - $os.FreeVirtualMemory)); Write-Output $os.TotalVirtualMemorySize"

const WINDOWS_CROSSCHECK =
  'powershell -NoProfile -Command "$os = Get-CimInstance Win32_OperatingSystem; ' +
  '($os.TotalVirtualMemorySize - $os.FreeVirtualMemory), $os.TotalVirtualMemorySize"'

/**
 * Interpret the probe's stdout. Pure, so the whole Windows path is testable on any host.
 *
 * `undefined` stdout means the probe could not run at all; that is a different fact from "it ran and
 * said something we cannot parse", and both are unknown rather than a number.
 */
export function windowsMemory(stdout: string | undefined): MemoryReading {
  if (stdout === undefined)
    return { known: false, reason: "Windows commit charge is unavailable: the PowerShell CIM probe did not run." }
  const [usedKb, limitKb] = stdout
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
  if (usedKb === undefined || limitKb === undefined)
    return {
      known: false,
      reason: "Windows commit charge is unavailable: Win32_OperatingSystem returned no usable commit figures.",
    }
  // Kilobytes on the wire — that unit is what Win32_OperatingSystem reports, and getting it wrong is a
  // 1024x error in the direction that reads as "plenty of room".
  return {
    known: true,
    source: "windows-commit",
    crosscheck: WINDOWS_CROSSCHECK,
    usedBytes: usedKb * 1024,
    limitBytes: limitKb * 1024,
  }
}

// ── linux: cgroup first, host second ────────────────────────────────────────────────────────────

/** Reads a proc/sysfs file, or `undefined` when it is absent. Injected so the dispatch is testable. */
export type FileReader = (path: string) => string | undefined

function parseKb(meminfo: string, key: string): number | undefined {
  const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB$`, "m").exec(meminfo)
  if (!match?.[1]) return undefined
  const value = Number(match[1])
  return Number.isFinite(value) ? value * 1024 : undefined
}

/** The cgroup path this process is in, from `/proc/self/cgroup`'s unified (`0::`) line. */
function cgroupV2Path(read: FileReader): string | undefined {
  const raw = read("/proc/self/cgroup")
  if (raw === undefined) return undefined
  for (const line of raw.split("\n")) {
    const [hierarchy, controllers, path] = line.split(":")
    if (hierarchy === "0" && controllers === "" && path) return path.trim()
  }
  return undefined
}

/**
 * Memory on Linux, cgroup limit first.
 *
 * ⚠️ On a containerized or systemd-scoped instance the cgroup ceiling IS the real limit and host RAM
 * is a lie — the Spark is exactly this case. So the host `/proc/meminfo` answer is the FALLBACK, never
 * the first choice, and a cgroup with no limit (`max`, or v1's ~2^63 sentinel) falls through to it
 * rather than reporting a limit of infinity.
 */
export function linuxMemory(read: FileReader): MemoryReading {
  const meminfo = read("/proc/meminfo")
  const memTotal = meminfo === undefined ? undefined : parseKb(meminfo, "MemTotal")

  const v2Path = cgroupV2Path(read)
  const scoped = v2Path === undefined || v2Path === "/" ? undefined : `/sys/fs/cgroup${v2Path}`
  for (const base of [scoped, "/sys/fs/cgroup"]) {
    if (base === undefined) continue
    const max = read(`${base}/memory.max`)?.trim()
    const current = read(`${base}/memory.current`)?.trim()
    if (max === undefined || current === undefined) continue
    if (max === "max") break // a cgroup exists but does not cap us — the host figures are the truth
    const limitBytes = Number(max)
    const usedBytes = Number(current)
    if (!Number.isFinite(limitBytes) || !Number.isFinite(usedBytes) || limitBytes <= 0) continue
    return {
      known: true,
      source: "linux-cgroup-v2",
      crosscheck: `cat ${base}/memory.current ${base}/memory.max`,
      usedBytes,
      limitBytes,
    }
  }

  const v1Limit = Number(read("/sys/fs/cgroup/memory/memory.limit_in_bytes")?.trim())
  const v1Used = Number(read("/sys/fs/cgroup/memory/memory.usage_in_bytes")?.trim())
  // v1 spells "no limit" as a number near 2^63, not as a word. Anything at or above host RAM is not a
  // cap — and the absolute bound is load-bearing on its own, because when /proc/meminfo is unreadable
  // there is no host RAM to compare against and the sentinel would sail through as a 9-exabyte limit,
  // i.e. a permanently-0% reading. A fabricated "plenty of room" is worse than an unknown (ruling 2).
  const v1Capped =
    Number.isFinite(v1Limit) && v1Limit > 0 && v1Limit < 2 ** 53 && (memTotal === undefined || v1Limit < memTotal)
  if (v1Capped && Number.isFinite(v1Used))
    return {
      known: true,
      source: "linux-cgroup-v1",
      crosscheck: "cat /sys/fs/cgroup/memory/memory.usage_in_bytes /sys/fs/cgroup/memory/memory.limit_in_bytes",
      usedBytes: v1Used,
      limitBytes: v1Limit,
    }

  if (meminfo === undefined || memTotal === undefined)
    return { known: false, reason: "Linux memory is unavailable: /proc/meminfo could not be read." }
  const memAvailable = parseKb(meminfo, "MemAvailable")
  if (memAvailable === undefined)
    return { known: false, reason: "Linux memory is unavailable: /proc/meminfo reports no MemAvailable." }
  // Swap counts on both sides: a box that is swapping is still running, and pretending its swap does not
  // exist would put the floor above where the machine actually dies.
  const swapTotal = parseKb(meminfo, "SwapTotal") ?? 0
  const swapFree = parseKb(meminfo, "SwapFree") ?? 0
  const limitBytes = memTotal + swapTotal
  return {
    known: true,
    source: "linux-meminfo",
    crosscheck: "grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
    usedBytes: Math.max(0, limitBytes - (memAvailable + swapFree)),
    limitBytes,
  }
}

/**
 * macOS reports compressed and free pages, not a commit charge, and `todo/resource-pressure.md` is
 * explicit that free pages are meaningless there — the OS compresses, so a "free" number would be a
 * fabricated reassurance. Until a real memory-pressure probe lands this says so out loud, which is
 * ruling 2 obeyed rather than a gap papered over.
 */
export const DARWIN_MEMORY: Unavailable = {
  known: false,
  reason:
    "macOS memory headroom is not measured yet: the OS compresses memory, so free pages do not predict " +
    "exhaustion and a number derived from them would be misleading. Disk headroom is still measured.",
}

const UNSUPPORTED_MEMORY = (platform: string): Unavailable => ({
  known: false,
  reason:
    `Memory headroom is not measured on ${platform}: ` +
    `no commit-charge equivalent is implemented for this platform.`,
})

// ── runners ─────────────────────────────────────────────────────────────────────────────────────

const readFileOrUndefined: FileReader = (path) => {
  try {
    return fs.readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

/**
 * Blocking read. For SCRIPTS ONLY (`script/lib/heavy-guard.ts`), which have no event loop to protect.
 *
 * ⚠️ Measured on this box: the PowerShell CIM probe costs 400–800 ms. Calling this on a request path
 * would block the server for that long, which is why the product path below is async and cached.
 */
export function memorySync(): MemoryReading {
  if (process.platform === "win32") {
    const proc = spawnSync("powershell", [...WINDOWS_COMMIT_ARGV, WINDOWS_COMMIT_SCRIPT], {
      encoding: "utf8",
      timeout: 15_000,
    })
    return windowsMemory(proc.status === 0 && proc.stdout ? proc.stdout : undefined)
  }
  if (process.platform === "linux") return linuxMemory(readFileOrUndefined)
  if (process.platform === "darwin") return DARWIN_MEMORY
  return UNSUPPORTED_MEMORY(process.platform)
}

/** Hard ceiling on the async probe. Nothing waits on this measurement longer than this, ever. */
export const MEMORY_PROBE_TIMEOUT_MS = 10_000

function windowsMemoryAsync(): Promise<MemoryReading> {
  return new Promise((resolve) => {
    let stdout = ""
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = (value: MemoryReading) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    try {
      const child = spawn("powershell", [...WINDOWS_COMMIT_ARGV, WINDOWS_COMMIT_SCRIPT], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      // ⚠️ Our OWN timer, not spawn's `timeout` option. A probe that never settles would leave
      // `inflight` pinned forever and every later caller would await a promise that can no longer
      // resolve — a wedge that looks exactly like a healthy cache (AGENTS.md: the wedge-vs-busy trap).
      // Killing by tree is the house rule for spawned children; this child spawns nothing itself.
      timer = setTimeout(() => {
        child.kill()
        done({
          known: false,
          reason:
            `Windows commit charge is unavailable: ` +
            `the PowerShell CIM probe did not answer within ${MEMORY_PROBE_TIMEOUT_MS} ms.`,
        })
      }, MEMORY_PROBE_TIMEOUT_MS)
      timer.unref?.()
      child.stdout.setEncoding("utf8")
      child.stdout.on("data", (chunk: string) => (stdout += chunk))
      child.on("error", () => done(windowsMemory(undefined)))
      child.on("close", (code) => done(windowsMemory(code === 0 && stdout ? stdout : undefined)))
    } catch {
      done(windowsMemory(undefined))
    }
  })
}

/** How long a memory reading is reused. The probe may end up on a per-turn path; 400 ms per turn is not free. */
export const MEMORY_CACHE_MS = 3_000

let cached: { readonly at: number; readonly value: MemoryReading } | undefined
let inflight: Promise<MemoryReading> | undefined

/** Drop the cache after a known large allocation/free (and between tests) so admission sees reality. */
export function resetMemoryCache(): void {
  cached = undefined
  inflight = undefined
}

/**
 * Memory headroom, cheap and lazy: cached for `MEMORY_CACHE_MS`, and concurrent callers share ONE probe
 * rather than each spawning their own PowerShell.
 */
export function memory(now: () => number = Date.now): Promise<MemoryReading> {
  const at = now()
  if (cached && at - cached.at < MEMORY_CACHE_MS) return Promise.resolve(cached.value)
  if (inflight) return inflight
  const probe =
    process.platform === "win32"
      ? windowsMemoryAsync()
      : Promise.resolve(
          process.platform === "linux"
            ? linuxMemory(readFileOrUndefined)
            : process.platform === "darwin"
              ? DARWIN_MEMORY
              : UNSUPPORTED_MEMORY(process.platform),
        )
  inflight = probe
    .catch(
      (cause): MemoryReading => ({
        known: false,
        reason: `Memory headroom is unavailable: the probe failed (${String(cause)}).`,
      }),
    )
    .then((value) => {
      cached = { at: now(), value }
      inflight = undefined
      return value
    })
  return inflight
}

/** Resident RAM for one process. This is deliberately RSS/working set, not host commit charge. */
export function processMemory(pid: number | undefined): Promise<ProcessMemoryReading> {
  if (!Number.isSafeInteger(pid) || !pid || pid <= 0)
    return Promise.resolve({
      known: false,
      reason: "Process memory is unavailable: no running process id was reported.",
    })
  if (pid === process.pid)
    return Promise.resolve({
      known: true,
      rssBytes: process.memoryUsage().rss,
      crosscheck: process.platform === "linux" ? `grep VmRSS /proc/${pid}/status` : `Get-Process -Id ${pid}`,
    })
  if (process.platform === "linux") {
    return Promise.resolve().then(() => {
      const text = readFileOrUndefined(`/proc/${pid}/status`)
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text ?? "")
      const kib = Number(match?.[1])
      return Number.isFinite(kib) && kib >= 0
        ? { known: true as const, rssBytes: kib * 1024, crosscheck: `grep VmRSS /proc/${pid}/status` }
        : { known: false as const, reason: `Process memory for pid ${pid} is unavailable from /proc.` }
    })
  }
  if (process.platform !== "win32")
    return Promise.resolve({ known: false, reason: `Process memory is not measured on ${process.platform}.` })

  return new Promise((resolve) => {
    let stdout = ""
    let settled = false
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", `(Get-Process -Id ${pid} -ErrorAction Stop).WorkingSet64`],
      { stdio: ["ignore", "pipe", "ignore"] },
    )
    const finish = (value: ProcessMemoryReading) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish({ known: false, reason: `Process memory for pid ${pid} did not answer within 5 seconds.` })
    }, 5_000)
    timer.unref?.()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (stdout += chunk))
    child.on("error", () => finish({ known: false, reason: `Process memory for pid ${pid} could not be measured.` }))
    child.on("close", (code) => {
      const bytes = Number(stdout.trim())
      finish(
        code === 0 && Number.isFinite(bytes) && bytes >= 0
          ? { known: true, rssBytes: bytes, crosscheck: `Get-Process -Id ${pid} | Select-Object WorkingSet64` }
          : { known: false, reason: `Process memory for pid ${pid} is unavailable because the process stopped.` },
      )
    })
  })
}

// ── disk ────────────────────────────────────────────────────────────────────────────────────────

export type Statfs = (path: string) => { bsize: number; blocks: number; bavail: number }

/**
 * Free bytes on the volume holding `target`. One `statfs` syscall — cheap enough to call per turn
 * uncached, which is why only memory is cached.
 *
 * ⚠️ A refusal to answer is `known: false`, never `freeBytes: 0`. `statfs` on a path that does not
 * exist throws; a platform that cannot fill `bsize` returns 0 there, and multiplying by it would
 * manufacture "0 bytes free" — the fabricated disk-full reading ruling 2 forbids. A genuine 0 from a
 * genuinely full volume still reports `known: true, freeBytes: 0`; the two are different facts.
 */
export function disk(target: string, statfs: Statfs = fs.statfsSync as unknown as Statfs): DiskReading {
  // An instance directory that has not been created yet is not a missing volume — walk up to the
  // nearest ancestor that exists. Reporting `unknown` because `$XDG_CACHE_HOME/novaclaw` is absent on a
  // fresh install would blind the guard on exactly the run where nothing has been written yet.
  let stat: { bsize: number; blocks: number; bavail: number } | undefined
  let measuredPath = target
  let lastCause: unknown
  for (let probe = target; ; ) {
    try {
      stat = statfs(probe)
      measuredPath = probe
      break
    } catch (cause) {
      lastCause = cause
      const parent = nodePath.dirname(probe)
      if (parent === probe) break
      probe = parent
    }
  }
  if (stat === undefined)
    return { known: false, path: target, reason: `Disk headroom for ${target} is unavailable: ${String(lastCause)}.` }
  if (!Number.isFinite(stat.bsize) || stat.bsize <= 0)
    return {
      known: false,
      path: target,
      reason: `Disk headroom for ${target} is unavailable: the filesystem reported no block size.`,
    }
  if (!Number.isFinite(stat.bavail) || stat.bavail < 0 || !Number.isFinite(stat.blocks) || stat.blocks < 0)
    return {
      known: false,
      path: target,
      reason: `Disk headroom for ${target} is unavailable: the filesystem reported no block counts.`,
    }
  return {
    known: true,
    path: target,
    measuredPath,
    freeBytes: stat.bavail * stat.bsize,
    totalBytes: stat.blocks * stat.bsize,
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────────────────────────

export function memoryLevel(reading: MemoryReading, thresholds: Thresholds): Level {
  if (!reading.known) return "unknown"
  if (reading.limitBytes <= 0) return "unknown"
  const used = reading.usedBytes / reading.limitBytes
  if (used >= thresholds.floor.memoryUsedFraction) return "floor"
  if (used >= thresholds.warning.memoryUsedFraction) return "warning"
  return "ok"
}

export function diskLevel(reading: DiskReading, thresholds: Thresholds): Level {
  if (!reading.known) return "unknown"
  if (reading.freeBytes <= thresholds.floor.diskFreeBytes) return "floor"
  if (reading.freeBytes <= thresholds.warning.diskFreeBytes) return "warning"
  return "ok"
}

const RANK: Record<Level, number> = { unknown: -1, ok: 0, warning: 1, floor: 2 }

export interface Report {
  readonly memory: MemoryReading
  readonly disks: readonly DiskReading[]
  readonly thresholds: Thresholds
  /** `invalid` means a stored `resource_pressure` value was rejected and the defaults are in force. */
  readonly thresholdsSource: ThresholdsSource
  /**
   * The worst level any KNOWN reading reached. `unknown` only when nothing could be measured at all —
   * an unmeasurable probe never votes `ok`, it withdraws and names itself in `unavailable`.
   */
  readonly level: Level
  /** Human-readable reasons for every probe that could not answer. Empty when everything was measured. */
  readonly unavailable: readonly string[]
}

export function report(input: {
  readonly memory: MemoryReading
  readonly disks: readonly DiskReading[]
  readonly thresholds: ResolvedThresholds
}): Report {
  const thresholds = input.thresholds.thresholds
  const levels = [memoryLevel(input.memory, thresholds), ...input.disks.map((entry) => diskLevel(entry, thresholds))]
  const known = levels.filter((level) => level !== "unknown")
  const unavailable = [
    ...(input.memory.known ? [] : [input.memory.reason]),
    ...input.disks.flatMap((entry) => (entry.known ? [] : [entry.reason])),
    ...(input.thresholds.source === "invalid"
      ? [`The stored \`${CONFIG_KEY}\` setting could not be read, so the shipped default thresholds are in force.`]
      : []),
  ]
  return {
    memory: input.memory,
    disks: input.disks,
    thresholds,
    thresholdsSource: input.thresholds.source,
    level: known.length === 0 ? "unknown" : known.reduce((worst, next) => (RANK[next] > RANK[worst] ? next : worst)),
    unavailable,
  }
}
