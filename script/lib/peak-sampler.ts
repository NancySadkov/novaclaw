/**
 * Measure what a run unit actually costs, so the harness can plan with a number instead of folklore.
 *
 * ⚠️ **It has to be a CHILD PROCESS, and that is not a style choice.** `script/test.ts` drives units
 * with `spawnSync`, which blocks the event loop for the entire unit — a timer in this process would
 * not fire once until the thing it was measuring had already finished.
 *
 * ⚠️ **And ONE child for the whole suite, not one per unit.** The first version started a sampler per
 * unit and measured nothing for the fast ones: PowerShell takes longer to start than `schema` takes
 * to run, so units under about a second were never sampled — and an unprofiled unit that can never
 * learn its own number is an unprofiled unit forever, which meant it sharded forever. So the sampler
 * runs once, APPENDS a timeline, and the parent slices that timeline by the window a unit occupied.
 *
 * Two series, because they answer two different questions:
 *   · `treeMb` — commit charge of every `bun` process except the runner itself: what the UNIT costs,
 *     which is what `memory-plan.ts` needs to plan the next run;
 *   · `hostCommitPct` — the machine's commit charge against its limit: what the BOX was doing, which
 *     is what tells a wall-clock kill caused by paging apart from a genuine hang.
 *
 * Commit charge, not working set: AGENTS.md → Known pitfalls #8 records a zombie holding 6.21 GB of
 * commit at `WorkingSet64 = 0`, and commit-vs-limit is the pair that predicted every crash we have
 * had. On POSIX there is no commit equivalent worth trusting, so RSS stands in and the host figure
 * comes from `MemAvailable`.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

export interface Sample {
  /** Peak MB across the measured process tree in the window, or undefined when nothing was sampled. */
  readonly treeMb?: number
  /** Peak host commit charge as a percentage of the limit in the window, or undefined. */
  readonly hostCommitPct?: number
}

export interface Sampler {
  /** Peak values recorded between two `Date.now()` stamps. Empty when the window caught no tick. */
  readonly window: (fromMs: number, toMs: number) => Sample
  /** Stop sampling and clean up. Safe to call twice. */
  readonly stop: () => void
}

/** A sampler that measures nothing — used when the platform probe is unavailable. */
const INERT: Sampler = { window: () => ({}), stop: () => {} }

/** 200 ms: fast enough that a sub-second unit still lands two or three ticks. */
const INTERVAL_MS = 200

const WINDOWS_LOOP = (file: string, rootPid: number) =>
  [
    `$f = '${file}'; $root = ${rootPid}`,
    "while ($true) {",
    "  $tm = 0; $hc = 0",
    // ⚠️ DESCENDANTS OF THE RUNNER, never "every bun on the box". The first version summed all bun
    // processes except this one and reported `core` at 12 014 MB against a hand-measured ~1 000 MB,
    // because an unrelated bun — a dev server, a stray from an earlier run — is indistinguishable by
    // name. A number that can be wrong by 12× is worse than no number here: it feeds the ladder, so
    // it would have refused a unit that fits.
    // `Where-Object` rather than `-Filter "Name='bun.exe'"`: the filter needs embedded double quotes,
    // which do not survive being passed through `-Command` as one argument — measured, and the
    // symptom was a silent zero rather than an error.
    // ⚠️ EVERY `bun` except the runner — deliberately, after an ancestry walk was tried and failed.
    //
    // The precise thing to measure is "descendants of this runner", and two attempts at it both
    // returned a silent zero while the host series kept working: `Win32_Process.PageFileUsage`
    // reports 0 on Windows 11, and reading parentage from WMI while reading memory from
    // `Get-Process` still found no match — bun's own spawn does not leave the parent chain WMI shows.
    // Rather than ship instrumentation whose failure mode is "looks like nothing to report", this
    // uses the form that is KNOWN to produce correct numbers (it is what the by-hand measurements in
    // notes/test-harness-memory.md used) and states its limitation out loud:
    //
    //   an unrelated `bun` — a dev server, a stray from a killed run — is counted too.
    //
    // That is survivable exactly because of how the number is used. The profile is REPORTED, never
    // enforced; the ladder's default for an unmeasured unit is generous; and `test.ts` discards an
    // implausible sample instead of recording it. The one real precondition — no second suite and no
    // build running — heavy-guard already enforces independently.
    "  $procs = Get-Process bun -ErrorAction SilentlyContinue | Where-Object { $_.Id -ne $root }",
    "  if ($procs) { $tm = ($procs | Measure-Object -Property PagedMemorySize64 -Sum).Sum / 1MB }",
    "  $o = Get-CimInstance Win32_OperatingSystem",
    "  if ($o.TotalVirtualMemorySize -gt 0) { $hc = 100 * ($o.TotalVirtualMemorySize - $o.FreeVirtualMemory) / $o.TotalVirtualMemorySize }",
    "  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  Add-Content -Path $f -Value ('{0} {1:N0} {2:N0}' -f $ms, $tm, $hc) -ErrorAction SilentlyContinue",
    `  Start-Sleep -Milliseconds ${INTERVAL_MS}`,
    "}",
  ].join("\n")

const POSIX_LOOP = (file: string, rootPid: number) =>
  [
    `f='${file}'; root=${rootPid}`,
    "while true; do",
    // Same rule, and the same stated limitation, as the Windows arm above: every `bun` but the
    // runner. RSS rather than commit, because POSIX has no commit-charge equivalent worth trusting.
    `  tm=$(ps -eo pid=,rss=,comm= | awk -v root="$root" '$3 ~ /(^|\\/)bun$/ && $1 != root { s += $2 } END { print int(s/1024) }')`,
    "  hc=0",
    "  if [ -r /proc/meminfo ]; then",
    "    hc=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t>0) print int(100*(t-a)/t); else print 0 }' /proc/meminfo)",
    "  fi",
    `  printf '%s %s %s\\n' "$(date +%s%3N)" "\${tm:-0}" "\${hc:-0}" >> "$f"`,
    `  sleep ${INTERVAL_MS / 1000}`,
    "done",
  ].join("\n")

/**
 * Start sampling. Never throws and never blocks: a harness that could not run because its own
 * instrumentation failed would be a worse trade than an unmeasured run.
 */
export function start(): Sampler {
  let dir: string
  try {
    dir = mkdtempSync(join(os.tmpdir(), "novaclaw-peak-"))
  } catch {
    return INERT
  }
  const file = join(dir, "timeline.txt")
  let child: ChildProcess
  try {
    child =
      process.platform === "win32"
        ? spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_LOOP(file, process.pid)], {
            stdio: "ignore",
            windowsHide: true,
          })
        : spawn("sh", ["-c", POSIX_LOOP(file, process.pid)], { stdio: "ignore" })
  } catch {
    rmSync(dir, { recursive: true, force: true })
    return INERT
  }

  let stopped = false
  return {
    window: (fromMs, toMs) => {
      let treeMb = 0
      let hostCommitPct = 0
      let seen = false
      try {
        for (const line of readFileSync(file, "utf8").split("\n")) {
          const [at, tree, host] = line.trim().split(/\s+/)
          const ts = Number(at)
          if (!Number.isFinite(ts) || ts < fromMs || ts > toMs) continue
          seen = true
          treeMb = Math.max(treeMb, Number(String(tree).replace(/[^\d]/g, "")) || 0)
          hostCommitPct = Math.max(hostCommitPct, Number(String(host).replace(/[^\d]/g, "")) || 0)
        }
      } catch {
        return {}
      }
      if (!seen) return {}
      return {
        ...(treeMb > 0 ? { treeMb } : {}),
        ...(hostCommitPct > 0 ? { hostCommitPct } : {}),
      }
    },
    stop: () => {
      if (stopped) return
      stopped = true
      try {
        // The sampler owns no children of its own, so a plain kill is enough — and it must be plain:
        // a tree kill here would be aimed at the same PowerShell heavy-guard reads with.
        child.kill("SIGKILL")
      } catch {
        /* already gone */
      }
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
