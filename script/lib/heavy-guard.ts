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

/** Windows commit charge vs limit — the pair that actually predicts the crash. */
function windowsCommit(): { usedGb: number; limitGb: number } | undefined {
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

/** Pure classifier kept public so adding a new inference/runtime process is pinned by a cheap test. */
export function heavyJobLabels(name: string, commandLine: string): string[] {
  if (!HEAVY_EXECUTABLES.test(name.trim())) return []
  if (/heavy-guard|Get-CimInstance|Win32_Process/i.test(commandLine)) return []
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

    const commit = windowsCommit()
    if (!commit && options.requireMeasurement)
      return {
        ok: false,
        reason: "Windows commit pressure could not be measured",
        detail:
          `NovaClaw could not read Win32_OperatingSystem.TotalVirtualMemorySize/FreeVirtualMemory.\n` +
          `The test runner fails closed because running a memory-heavy test without the crash-predicting ` +
          `measurement would only guess that the machine is safe.`,
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
  const freeFraction = os.freemem() / os.totalmem()
  if (freeFraction < 0.08)
    return {
      ok: false,
      reason: "the machine is already low on memory",
      detail: `Only ${(os.freemem() / 1024 ** 3).toFixed(1)} GB of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB RAM is free.`,
    }
  return { ok: true }
}

/** Print the refusal and exit non-zero, or return quietly when it is safe to proceed. */
export function enforce(label: string, argv: readonly string[] = process.argv, options: Options = {}): void {
  const verdict = check(argv, options)
  if (verdict.ok) return
  process.stderr.write(`\n\x1b[31mRefusing to start ${label}: ${verdict.reason}.\x1b[0m\n${verdict.detail ?? ""}\n\n`)
  process.exit(2)
}
