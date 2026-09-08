/**
 * Refuses to start a memory-heavy job when the machine cannot afford it.
 *
 * WHY THIS EXISTS. On 2026-07-27 the test suite was started while an electron-builder release build was
 * already running. Commit charge peaked at **58 GB against a 44.7 GB limit** — Windows grew the pagefile
 * to absorb it — and free RAM fell to 0.5 GB. `core` was wall-clock-killed at 150 s (it normally takes
 * ~110–136 s), so the run was not merely slow, it produced a FALSE FAILURE. The same shape hard-crashed
 * the machine on 2026-07-20 (AGENTS.md → Known pitfalls #1 and #8b). Sustained swapping is also written
 * to the SSD, which is real wear, not a scratchpad.
 *
 * AGENTS.md already said "run typechecks/suites SEQUENTIALLY, never in parallel with each other or a
 * heavy suite". A rule in a document did not stop it. This turns the rule into a mechanism — the same
 * lesson as the harness law in jh.md: informational levers engage, mechanical ones convert.
 *
 * Two independent checks, because they catch different mistakes:
 *   1. a CONCURRENCY check — another heavy job of ours is already running;
 *   2. a MEMORY FLOOR — commit charge is already high, whatever the cause (per pitfall #8b, commit vs
 *      limit is the number that matters; the box "works" at 99% commit for a day before dying).
 *
 * Builds retain an explicit escape hatch. The test runner deliberately disables it: an agent must not
 * be able to turn a safety refusal into an OOM by adding `--force` to a test command.
 */
import { spawnSync } from "node:child_process"
import os from "node:os"

import { writeDiagnostic } from "./diagnostic"

/** Commit charge above this fraction of the limit means: do not add a second heavy job. */
const COMMIT_CEILING = 0.75
/** The full test suite is the largest guarded job and retains the conservative incident-derived floor. */
const DEFAULT_MIN_FREE_BYTES = 6 * 1024 ** 3

export function hasEnoughFreeMemory(freeBytes: number, minimumFreeBytes: number = DEFAULT_MIN_FREE_BYTES): boolean {
  return Number.isFinite(freeBytes) && freeBytes >= minimumFreeBytes
}

export interface Verdict {
  readonly ok: boolean
  readonly reason?: string
  readonly detail?: string
}

export interface Options {
  /** Builds may opt out deliberately. Tests set this false so the memory invariant cannot be bypassed. */
  readonly allowOverride?: boolean
  /** A heavy test is unsafe when the host measurement itself is unavailable, so tests fail closed. */
  readonly requireMeasurement?: boolean
  /** A measured stage-specific floor; omitted for the conservative full-suite default. */
  readonly minimumFreeBytes?: number
  /**
   * THIS runner already has units in flight, so only the foreign-job arm is meaningful.
   *
   * 🔴 **Without this the concurrent gate refuses itself.** The pressure arms below read the whole
   * machine, and a pool of our own units is *supposed* to consume it: `core` alone runs at a median
   * of 74 % commit, so a second unit beside it crosses the 75 % ceiling by design and the run would
   * exit(2) in the middle of its own work. The two arms are not deleted — they are the wrong
   * instrument once the runner is the thing holding the memory.
   *
   * ⚠️ **What replaces them is the ADMISSION side, not nothing.** `script/test.ts` hands out
   * `MemoryPlan.requiredBytes` reservations from a budget measured while the pool was empty, and
   * refuses to admit anything while host commit is at or above the 90 % floor. That is a stricter
   * test of the same property, because a reservation covers memory a unit has not yet allocated
   * while a live reading cannot.
   *
   * The foreign-job arm stays ARMED, and that is the point of having a flag rather than skipping the
   * call: a release build or a local model started mid-gate is exactly the 2026-07-27 cascade, and
   * no amount of budgeting on our side accounts for it.
   */
  readonly ownWorkInFlight?: boolean
}

export function bypassesGuard(
  argv: readonly string[],
  environment: Readonly<Record<string, string | undefined>>,
  options: Options,
): boolean {
  return (
    options.allowOverride !== false &&
    (argv.includes("--force") || environment.NOVACLAW_SKIP_HEAVY_GUARD === "1" || environment.CI === "true")
  )
}

export interface MemoryHeadroom {
  /** Immediately available physical memory — the wall a resident working set consumes. */
  readonly residentBytes: number
  /** Remaining Windows commit capacity. Equals residentBytes where RSS is the only honest measure. */
  readonly commitBytes: number
}

/**
 * Host commit charge as a percentage, or `undefined` where it cannot be measured.
 *
 * The same quantity `test.ts` records per unit as `hostCommitPct`, exposed so the gate can ASK before
 * it starts a unit rather than only learn afterwards. ⚠️ Windows-only in substance: elsewhere there
 * is no commit charge and free RAM is the honest measure, so this answers `undefined` rather than
 * inventing a percentage out of a different quantity.
 */
export function hostCommitPct(): number | undefined {
  if (process.platform !== "win32") return undefined
  const commit = windowsCommit()
  if (!commit || commit.limitGb <= 0) return undefined
  return Math.round((commit.usedGb / commit.limitGb) * 100)
}

/** Measure the two independent memory walls without collapsing unlike quantities through `min()`. */
export function memoryHeadroom(): MemoryHeadroom | undefined {
  const free = os.freemem()
  if (process.platform !== "win32")
    return Number.isFinite(free) && free > 0 ? { residentBytes: free, commitBytes: free } : undefined
  const commit = windowsCommit()
  if (!commit) return undefined
  const commitFree = (commit.limitGb - commit.usedGb) * 1024 ** 3
  if (!Number.isFinite(free) || free <= 0 || !Number.isFinite(commitFree)) return undefined
  return { residentBytes: Math.max(0, free), commitBytes: Math.max(0, commitFree) }
}

/**
 * The biggest memory consumers on the box, for a refusal that names WHO rather than only how much.
 *
 * "Only 3.7 GB is available" is a constant, not a situation: it tells the reader nothing they can
 * act on. This is one extra query against a table the guard already reads, and it turns the message
 * into a list of things to close.
 */
export function topConsumers(limit = 5): string[] {
  if (process.platform !== "win32") return []
  const script =
    "Get-Process | Sort-Object -Property PagedMemorySize64 -Descending | Select-Object -First " +
    `${limit} | ForEach-Object { "$($_.ProcessName)\`t$([Math]::Round($_.PagedMemorySize64/1MB))" }`
  const proc = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 15_000,
  })
  if (proc.status !== 0 || !proc.stdout) return []
  const rows: string[] = []
  for (const line of proc.stdout.split(/\r?\n/)) {
    const [name, mb] = line.split("\t")
    if (!name?.trim() || !mb?.trim()) continue
    rows.push(`${name.trim()} ${mb.trim()} MB`)
  }
  return rows
}

/** How many times the commit probe may miss before the runner refuses. See `windowsCommit`. */
const COMMIT_PROBE_ATTEMPTS = 3
/** The admission pass asks for the same commit pair more than once; keep those reads coherent. */
const COMMIT_CACHE_MS = 1_000
let commitCache: { readonly at: number; readonly value: { usedGb: number; limitGb: number } | undefined } | undefined

/** One attempt at the commit charge. `undefined` = this probe did not answer. */
function windowsCommitOnce(): { usedGb: number; limitGb: number } | undefined {
  const script =
    "$os = Get-CimInstance Win32_OperatingSystem; " +
    "Write-Output (($os.TotalVirtualMemorySize - $os.FreeVirtualMemory)); Write-Output $os.TotalVirtualMemorySize"
  const proc = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 15_000,
  })
  if (proc.status !== 0 || !proc.stdout) return undefined
  const [usedKb, limitKb] = proc.stdout
    .split(/\r?\n/)
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (usedKb === undefined || limitKb === undefined) return undefined
  return { usedGb: (usedKb * 1024) / 1024 ** 3, limitGb: (limitKb * 1024) / 1024 ** 3 }
}

/**
 * Windows commit charge vs limit — the pair that actually predicts the crash.
 *
 * ⚠️ **Retried, because a single WMI miss used to discard a six-minute gate.** Measured 2026-08-06: a
 * full run aborted with *"Windows commit pressure could not be measured"*, and both `Get-CimInstance`
 * and `Get-WmiObject` answered normally seconds later — the box was at 22.6 GB free of 48.2 GB, i.e.
 * nowhere near pressure. The refusal itself is RIGHT and stays: running a memory-heavy unit on an
 * unmeasured machine is the 2026-07-20 hard crash waiting to happen. What was wrong is treating ONE
 * transient miss as an answer.
 */
function windowsCommit(): { usedGb: number; limitGb: number } | undefined {
  const now = Date.now()
  if (commitCache !== undefined && now - commitCache.at < COMMIT_CACHE_MS) return commitCache.value
  for (let attempt = 1; attempt <= COMMIT_PROBE_ATTEMPTS; attempt++) {
    const reading = windowsCommitOnce()
    if (reading) {
      commitCache = { at: Date.now(), value: reading }
      return reading
    }
    if (attempt < COMMIT_PROBE_ATTEMPTS) {
      // Announced, because a silent pause before a refusal is indistinguishable from a slow unit —
      // which is exactly how the 2026-08-06 abort read for ten minutes.
      process.stdout.write(
        `  commit-pressure probe attempt ${attempt}/${COMMIT_PROBE_ATTEMPTS} did not answer — retrying\n`,
      )
      // Synchronous on purpose: this guard runs before any unit starts, so nothing may interleave.
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Milliseconds 1000"], {
        timeout: 5_000,
      })
    }
  }
  commitCache = { at: Date.now(), value: undefined }
  return undefined
}

/** Our own heavy jobs, by the command line that identifies them. */
const HEAVY_PATTERNS: Array<{ label: string; match: RegExp }> = [
  { label: "an electron-builder package step", match: /electron-builder|app-builder/i },
  { label: "an electron-vite build", match: /electron-vite\s+build/i },
  { label: "a desktop prebuild (server sidecar bundle)", match: /scripts[\\/]prebuild\.ts|script[\\/]build-node\.ts/i },
  { label: "a CLI binary build", match: /packages[\\/]novaclaw[\\/]script[\\/]build\.ts/i },
  { label: "another test suite run", match: /script[\\/]test\.ts/i },
  { label: "a typecheck (tsgo)", match: /tsgo/i },
  { label: "a local llama.cpp model server", match: /llama-server/i },
]

/**
 * Only these executables can BE a heavy job. Matching on the command line alone gave a false positive
 * immediately: a PowerShell one-liner that merely *mentioned* `tsgo` in its query string matched itself.
 * A guard that blocks the suite because someone grepped for a word is worse than no guard.
 */
const HEAVY_EXECUTABLES = /^(bun|node|electron|app-builder|tsgo|tsgo-.*|llama-server)\.exe$/i

/**
 * A `bun test <paths>` spawn: one of the runner's own units, or someone running a file by hand.
 *
 * 🔴 **This exists because the gate refused ITSELF, and the mechanism is the same false positive
 * `HEAVY_EXECUTABLES` was written for one level down.** The `desktop` run unit is spawned as
 * `bun test src electron-builder.config.test.ts scripts` — so the pattern `/electron-builder/`
 * matches a **test file name** and reports *"an electron-builder package step"*. Under the serial
 * runner this was invisible: the guard only ever ran between units, when that `bun` was already
 * gone. The pool put `desktop` in flight while the next unit was admitted, and the whole run exited
 * 2 with a refusal naming a build that did not exist.
 *
 * ⚠️ **Nothing is lost by excluding these**, which is the test for whether an exclusion is honest.
 * A bare `bun test packages/core` matches no pattern here today either — the arm that catches a
 * rival suite matches `script/test.ts`, i.e. the RUNNER, and a runner is `bun script/test.ts`, not
 * `bun test`. So this narrows the classifier onto exactly the string that was never a job.
 */
const isBunTestUnit = (name: string, commandLine: string): boolean =>
  /^bun(\.exe)?$/i.test(name.trim()) && /^(?:"[^"]*"|\S+)\s+test(?:\s|$)/.test(commandLine.trim())

/** Pure classifier kept public so adding a new inference/runtime process is pinned by a cheap test. */
export function heavyJobLabels(name: string, commandLine: string): string[] {
  if (!HEAVY_EXECUTABLES.test(name.trim())) return []
  if (/heavy-guard|Get-CimInstance|Win32_Process/i.test(commandLine)) return []
  if (isBunTestUnit(name, commandLine)) return []
  return HEAVY_PATTERNS.filter((entry) => entry.match.test(commandLine)).map((entry) => entry.label)
}

/** Running processes that are genuinely one of our heavy jobs, excluding this process and its parent. */
function windowsHeavyJobs(): string[] {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | " +
    'ForEach-Object { "$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)" }'
  const proc = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (proc.status !== 0 || !proc.stdout) return []
  const found = new Set<string>()
  for (const line of proc.stdout.split(/\r?\n/)) {
    const [pidText, name, ...rest] = line.split("\t")
    if (pidText === undefined || name === undefined || rest.length === 0) continue
    const pid = Number(pidText.trim())
    const cmd = rest.join("\t")
    if (!Number.isFinite(pid) || pid === process.pid || pid === process.ppid) continue
    for (const label of heavyJobLabels(name, cmd)) found.add(`${label} (pid ${pid})`)
  }
  return [...found]
}

export function check(argv: readonly string[] = process.argv, options: Options = {}): Verdict {
  if (bypassesGuard(argv, process.env, options)) return { ok: true }

  if (process.platform === "win32") {
    const jobs = windowsHeavyJobs()
    if (jobs.length)
      return {
        ok: false,
        reason: "another heavy job is already running on this machine",
        detail:
          `Found: ${jobs.join(", ")}.\n` +
          `Running a build and the suite together drove commit charge to 58 GB of a 44.7 GB limit on\n` +
          `2026-07-27 and wall-clock-killed core at 150s — a FALSE failure, plus SSD wear from swapping.\n` +
          `Stop the listed job (including NovaClaw's local model, if named), then re-run. ` +
          `The test runner has no force override because a red test is better than an OOM.`,
      }

    // Our own pool is holding the machine down on purpose — see `ownWorkInFlight`. The arms below
    // measure the box, so from here they would be measuring US.
    if (options.ownWorkInFlight) return { ok: true }

    const commit = windowsCommit()
    if (!commit && options.requireMeasurement)
      return {
        ok: false,
        reason: "Windows commit pressure could not be measured",
        detail:
          `NovaClaw could not read Win32_OperatingSystem.TotalVirtualMemorySize/FreeVirtualMemory ` +
          `on ${COMMIT_PROBE_ATTEMPTS} attempts a second apart.\n` +
          `The test runner fails closed because running a memory-heavy test without the crash-predicting ` +
          `measurement would only guess that the machine is safe.\n` +
          // ⚠️ Says what to DO. The 2026-08-06 abort printed the fact and left the reader to work out
          // whether the run had stopped or was merely slow — ten minutes of a six-minute gate.
          `THE RUN HAS STOPPED — this is not a slow unit. If WMI answers now ` +
          `(\`Get-CimInstance Win32_OperatingSystem\`), it was a transient miss and a re-run will pass.`,
      }
    if (commit && commit.usedGb / commit.limitGb > COMMIT_CEILING)
      return {
        ok: false,
        reason: "the machine is already low on memory",
        detail:
          `Commit charge is ${commit.usedGb.toFixed(1)} GB of ${commit.limitGb.toFixed(1)} GB ` +
          `(${((100 * commit.usedGb) / commit.limitGb).toFixed(0)}%, ceiling ${COMMIT_CEILING * 100}%).\n` +
          `Close what you can (stray bun/node processes are the usual culprits — see AGENTS.md #8) and\n` +
          `re-run. Starting now risks a wall-clock kill that looks like a real test failure.`,
      }
    const freeBytes = os.freemem()
    const minimumFreeBytes = options.minimumFreeBytes ?? DEFAULT_MIN_FREE_BYTES
    if (!hasEnoughFreeMemory(freeBytes, minimumFreeBytes))
      return {
        ok: false,
        reason: "the machine does not have enough immediately available RAM",
        detail:
          `Only ${(freeBytes / 1024 ** 3).toFixed(1)} GB RAM is available; a guarded build or test needs ` +
          `at least ${(minimumFreeBytes / 1024 ** 3).toFixed(1)} GB before it starts.\n` +
          `Close memory-heavy applications or stop an unused local model, then re-run. The guard refuses ` +
          `before Windows is forced into sustained paging.`,
      }
    return { ok: true }
  }

  // Non-Windows: no commit-charge equivalent worth trusting, so use available RAM as a coarse floor.
  // The same exemption applies — a pool of our own units eats free RAM by design, and there is no
  // foreign-job arm on this platform to keep armed beside it.
  if (options.ownWorkInFlight) return { ok: true }
  const freeFraction = os.freemem() / os.totalmem()
  if (freeFraction < 0.08)
    return {
      ok: false,
      reason: "the machine is already low on memory",
      detail: `Only ${(os.freemem() / 1024 ** 3).toFixed(1)} GB of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM is free.`,
    }
  return { ok: true }
}

/**
 * Print the refusal and exit non-zero, or return quietly when it is safe to proceed.
 *
 * ⚠️ **`writeDiagnostic`, not `process.stderr.write`.** The refusal text is the ONLY output this path
 * produces — which unit, how much was needed, who is holding it — and it is followed immediately by a
 * hard exit, which is the shape `script/test.ts`'s footer forbids for buffered streams. This function
 * owning both halves is what stops a caller from writing one and forgetting the other; what was and
 * was not measured about the truncation is in `lib/diagnostic.ts`.
 *
 * ⚠️ `script/test.ts` deliberately does NOT use this — it needs `abort`, which kills the pool first.
 * The only caller is `packages/desktop/scripts/prebuild.ts`, which holds no children.
 */
export function enforce(label: string, argv: readonly string[] = process.argv, options: Options = {}): void {
  const verdict = check(argv, options)
  if (verdict.ok) return
  writeDiagnostic(`\n\x1b[31mRefusing to start ${label}: ${verdict.reason}.\x1b[0m\n${verdict.detail ?? ""}\n\n`)
  process.exit(2)
}
