export * as ProcessCommit from "./process-commit"

import { spawn } from "node:child_process"
import fs from "node:fs"

/**
 * WHAT A PROCESS IS COSTING THE HOST — read from OUTSIDE it, in one query, for the whole fleet.
 *
 * 🔴 **This is the product's ONLY memory instrument, and that is the whole point of it living here.**
 * It used to live in `packages/novaclaw/src/storage/worker-commit.ts`, where the session worker could
 * reach it and `core` could not — so the memory-graph worker's ceiling in `kb-graph/isolated-engine.ts`
 * had no way to use the correct reader and read a self-reported one instead. A guard that only one
 * caller can afford is a guard the other callers route around. `core` is the lowest package both can
 * import, so the instrument belongs here and every bound in the product reads it.
 *
 * 🔴 **WHY COMMIT AND NOT WORKING SET — the defect this file exists to stop repeating.**
 * Working set is a number the operating system is free to shrink. Measured 2026-09-28 on a live
 * instance: a `novaclaw` process held **6.32 GB of commit at 18.5 MB of working set**, idle, and the
 * per-worker limit (2 GiB) never fired — because the limit was evaluated against the worker's
 * SELF-REPORTED `process.memoryUsage.rss()`. 18.5 MB is 31× under the ceiling, so the process that
 * was starving the host looked tiny to the only code that could have stopped it. The host's commit
 * budget is what actually runs out, so commit is the quantity a bound must be written against.
 *
 * ⚠️ **The metric is platform-specific ON PURPOSE, and it rides WITH the reading.** On Windows that is
 * COMMIT (`PagedMemorySize64`), because Windows charges commit against a hard system-wide limit and
 * refuses allocations when it runs out. On Linux it is RSS, because Linux overcommits by design and
 * `VmSize` there is mostly unbacked address space that would condemn healthy processes. Reporting one
 * number under one name across both would be a lie in whichever direction the reader guessed — so a
 * caller that shows this number to a person carries {@link Metric} with it.
 *
 * ⚠️ **Why a shell, and why one.** Reading another process's commit portably needs the OS. This spawns
 * ONE process for the WHOLE fleet: sampling per-pid instead would make a memory guard that is itself a
 * memory problem, costing a shell per worker per reading. A fleet of nothing spawns nothing at all.
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
      windowsHide: true,
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

/**
 * The reading for ONE pid, or `undefined` when it could not be read.
 *
 * ⚠️ **`undefined` means UNKNOWN, never "small".** A caller bounding a process must treat this as
 * "cannot enforce right now", not as permission to continue silently — a guard that reads a missing
 * measurement as a passing one is the defect this file's header is about, one level up.
 */
export const read = async (
  pid: number,
  platform: string = process.platform,
): Promise<{ readonly bytes: number; readonly metric: Metric } | undefined> => {
  const result = await sample([pid], platform)
  if (result.unavailable !== undefined) return undefined
  const found = result.readings.find((reading) => reading.pid === pid)
  return found === undefined ? undefined : { bytes: found.bytes, metric: result.metric }
}
