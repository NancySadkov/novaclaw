export * as WorkerCommit from "./worker-commit"

import { spawn } from "node:child_process"
import fs from "node:fs"

/**
 * WHAT EACH LIVE SESSION WORKER IS COSTING THE HOST — read from OUTSIDE the worker, in one query.
 *
 * 🔴 **Why this exists beside `pressure.ts`'s `processMemory`.** That one answers a different
 * question and says so: *"deliberately RSS/working set, not host commit charge"*. Two things make it
 * the wrong instrument for a fleet watchdog, both measured 2026-08-24
 * (`notes/reports/worker-memory-guard-2026-08-24.md`):
 *
 *   1. **Working set hides the failure.** A trimmed process owes the system gigabytes of commit at a
 *      working set near zero — the zombie-bun shape already on the record. A watchdog reading working
 *      set would report a worker as small precisely while it is the reason the host is dying.
 *   2. **It spawns a shell PER PID.** Sampling a fleet that way costs a process per worker per tick,
 *      which is a memory guard that is itself a memory problem. This takes ONE reading for every pid
 *      at once, so the cost does not grow with the fleet.
 *
 * ⚠️ **The metric is platform-specific ON PURPOSE, and the choice is "what predicts exhaustion here".**
 * On Windows that is COMMIT (`PagedMemorySize64`), because Windows charges commit against a hard
 * system-wide limit and refuses allocations when it runs out. On Linux it is RSS, because Linux
 * overcommits by design — `VmSize` there is mostly unbacked address space and would condemn healthy
 * processes. Reporting one number under one name across both would be a lie in whichever direction
 * the reader guessed, so `metric` rides WITH the reading.
 */

/** Which number `bytes` is, so a caller never has to infer it from `process.platform`. */
export type Metric = "commit" | "rss"

export interface Reading {
  readonly pid: number
  readonly bytes: number
}

export interface Sample {
  /** Readings for the pids that answered. A pid that has exited is simply absent — not an error. */
  readonly readings: ReadonlyArray<Reading>
  readonly metric: Metric
  /** Set when NOTHING could be read. ⚠️ Never conflate with "every process was small". */
  readonly unavailable?: string | undefined
}

/** How long a sample may take before it is abandoned. A watchdog that blocks is worse than a blind one. */
const TIMEOUT_MS = 5_000

/**
 * Parse `"<pid> <bytes>"` lines.
 *
 * Split out so the parsing is testable without a host: the shell half cannot run in CI on every
 * platform, and a watchdog whose parser is only exercised by the thing it guards is a guard nobody
 * has read the output of.
 */
export const parseLines = (text: string): ReadonlyArray<Reading> => {
  const readings: Reading[] = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const bytes = Number(match[2])
    // A zero is a real answer (a process can legitimately owe nothing yet); a NaN is not.
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isFinite(bytes) && bytes >= 0) readings.push({ pid, bytes })
  }
  return readings
}

/** `VmRSS:\t   12345 kB` → bytes. Exported for the same reason `parseLines` is. */
export const parseProcStatus = (text: string): number | undefined => {
  const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(text)
  const kib = Number(match?.[1])
  return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : undefined
}

const metricFor = (platform: string): Metric => (platform === "win32" ? "commit" : "rss")

const readLinux = (pids: ReadonlyArray<number>): Sample => {
  const readings: Reading[] = []
  for (const pid of pids) {
    let text: string
    try {
      text = fs.readFileSync(`/proc/${pid}/status`, "utf8")
    } catch {
      // Exited between the caller listing it and us reading it. Absent, not an error.
      continue
    }
    const bytes = parseProcStatus(text)
    if (bytes !== undefined) readings.push({ pid, bytes })
  }
  return { readings, metric: "rss" }
}

const readWindows = (pids: ReadonlyArray<number>): Promise<Sample> =>
  new Promise((resolve) => {
    let stdout = ""
    let settled = false
    const finish = (value: Sample) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    // ONE process for the whole fleet. `-ErrorAction SilentlyContinue` so a pid that exited between
    // listing and sampling drops out of the answer instead of failing the sample for its siblings.
    const script =
      `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ` +
      `ForEach-Object { "$($_.Id) $($_.PagedMemorySize64)" }`
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      stdio: ["ignore", "pipe", "ignore"],
    })
    const timer = setTimeout(() => {
      child.kill()
      finish({ readings: [], metric: "commit", unavailable: "the memory sample did not answer within 5 seconds" })
    }, TIMEOUT_MS)
    timer.unref?.()
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => (stdout += chunk))
    child.on("error", () =>
      finish({ readings: [], metric: "commit", unavailable: "the memory sample could not be taken" }),
    )
    child.on("close", () => finish({ readings: parseLines(stdout), metric: "commit" }))
  })

/**
 * Sample every pid in one go.
 *
 * ⚠️ An empty `pids` returns an empty sample WITHOUT spawning anything — a fleet of nothing must not
 * cost a process every tick.
 */
export const sample = (pids: ReadonlyArray<number>, platform: string = process.platform): Promise<Sample> => {
  const wanted = [...new Set(pids)].filter((pid) => Number.isSafeInteger(pid) && pid > 0)
  if (wanted.length === 0) return Promise.resolve({ readings: [], metric: metricFor(platform) })
  if (platform === "linux") return Promise.resolve(readLinux(wanted))
  if (platform === "win32") return readWindows(wanted)
  return Promise.resolve({
    readings: [],
    metric: metricFor(platform),
    unavailable: `worker memory is not measured on ${platform}`,
  })
}
