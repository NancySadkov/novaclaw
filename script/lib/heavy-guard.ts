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
 * Escape hatch: `--force`, or NOVACLAW_SKIP_HEAVY_GUARD=1 for CI, which is not memory-starved and where
 * a refusal would be a false failure of its own.
 */
import { spawnSync } from "node:child_process"
import os from "node:os"

/** Commit charge above this fraction of the limit means: do not add a second heavy job. */
const COMMIT_CEILING = 0.75

export interface Verdict {
  readonly ok: boolean
  readonly reason?: string
  readonly detail?: string
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
]

/**
 * Only these executables can BE a heavy job. Matching on the command line alone gave a false positive
 * immediately: a PowerShell one-liner that merely *mentioned* `tsgo` in its query string matched itself.
 * A guard that blocks the suite because someone grepped for a word is worse than no guard.
 */
const HEAVY_EXECUTABLES = /^(bun|node|electron|app-builder|tsgo|tsgo-.*)\.exe$/i

/** Running processes that are genuinely one of our heavy jobs, excluding this process and its parent. */
function windowsHeavyJobs(): string[] {
  const script =
    "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine } | " +
    "ForEach-Object { \"$($_.ProcessId)`t$($_.Name)`t$($_.CommandLine)\" }"
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
    if (!HEAVY_EXECUTABLES.test(name.trim())) continue
    // The guard's own probe, and any process merely talking ABOUT these tools, are not heavy jobs.
    if (/heavy-guard|Get-CimInstance|Win32_Process/i.test(cmd)) continue
    for (const { label, match } of HEAVY_PATTERNS) if (match.test(cmd)) found.add(`${label} (pid ${pid})`)
  }
  return [...found]
}

export function check(argv: readonly string[] = process.argv): Verdict {
  if (argv.includes("--force") || process.env.NOVACLAW_SKIP_HEAVY_GUARD === "1" || process.env.CI === "true")
    return { ok: true }

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
          `Wait for it to finish, then re-run. Use --force only if you know the box can take it.`,
      }

    const commit = windowsCommit()
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
export function enforce(label: string, argv: readonly string[] = process.argv): void {
  const verdict = check(argv)
  if (verdict.ok) return
  process.stderr.write(
    `\n\x1b[31mRefusing to start ${label}: ${verdict.reason}.\x1b[0m\n${verdict.detail ?? ""}\n\n`,
  )
  process.exit(2)
}
