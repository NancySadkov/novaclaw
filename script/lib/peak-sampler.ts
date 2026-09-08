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
 *   · `treeMb` — commit charge of the `bun` processes THIS UNIT created: what the UNIT costs, which is
 *     what `memory-plan.ts` needs to plan the next run;
 *   · `hostCommitPct` — the machine's commit charge against its limit: what the BOX was doing, which
 *     is what tells a wall-clock kill caused by paging apart from a genuine hang.
 *
 * Commit charge remains the planner's primary measurement: AGENTS.md → Known pitfalls #8 records a
 * zombie holding 6.21 GB of commit at `WorkingSet64 = 0`, and commit-vs-limit is the pair that
 * predicted every crash we have had. Resident working set now travels beside it because free RAM is
 * a resident constraint, not a commit constraint; the two must not be compared crosswise. On POSIX
 * there is no commit equivalent worth trusting, so RSS stands in for both and the host figure comes
 * from `MemAvailable`.
 *
 * ─── ATTRIBUTION: by process BIRTH TIME, not by name and not by ancestry (2026-08-07) ───────────────
 *
 * 🔴 **Summing every `bun` on the box was wrong in both directions at once, and it cost four gates.**
 * `packages/core/test/util/flock.test.ts` and `util/effect-flock.test.ts` each spawn `const n = 16`
 * concurrent workers with `process.execPath` — which under `bun test` **is `bun.exe`**. So `core`'s
 * own children were indistinguishable from a stray by name, its tree summed to **16 758 MB**, and
 * `test.ts` discarded the whole reading against an 8 192 MB ceiling. The row then read exactly like a
 * unit nobody had sampled. Meanwhile the runner's PARENT — the `bun run test` npm-script shim, a
 * constant 41–45 MB for the whole gate — was counted into every unit, and for a sub-second unit it
 * was the ONLY thing counted: `schema` recorded **43** and `effect-drizzle-sqlite` **45**, the shim
 * alone, and a `ratio` was derived from it. That is worse than a null; a null announces itself.
 *
 * ⛔ **Ancestry does not work here and the reason is now measured rather than guessed.** `core`'s
 * worker was PID 31712 with `ParentProcessId = 8072`, and **8072 was already dead**: `bun test`
 * re-execs and the intermediate parent exits, so the real worker is an orphan and a descendant walk
 * from the runner finds nothing. Two attempts died that way, both reporting a silent zero.
 *
 * ⛔ **"Snapshot the live PIDs before the unit and count the new ones" does not work either**, and it
 * fails in the one way that is hard to see: **a process table keyed on PID is not a timeline.** PID
 * 12528 appeared twice in one gate, minutes apart, and a first-seen/last-seen table rendered the
 * reuse as a single 183-second life — which manufactured a phantom stray and falsified a written-down
 * prediction. Any set-of-PIDs membership test inherits that bug.
 *
 * ✅ **So the sampler records a process IDENTITY — `(pid, startMs)` — on every tick, and a process is
 * attributed to a unit when it was BORN at or after that unit's window opened.** A reused PID carries
 * a new birth time, so it is judged on its own merits and the reuse hazard cannot arise. This is also
 * exactly the test that excludes the shim and any pre-existing stray: both predate the window.
 *
 * ⚠️ **What it still cannot separate**, stated out loud rather than papered over: a genuinely
 * unrelated `bun` started *during* a unit's window (someone launching a dev server mid-gate) is
 * counted. That is a far narrower hole than "any bun anywhere", and heavy-guard independently refuses
 * to start a unit next to a second suite or a build. `foreignMb` reports what the window EXCLUDED, so
 * the exclusion is visible in the run output rather than being an invisible claim.
 *
 * ⚠️ **A process whose birth time cannot be read is treated as FOREIGN**, never as ours. Over-claiming
 * inflates the ladder's input, which is the failure this whole change exists to end.
 *
 * ─── THE LOOP BOUNDS ITSELF, because its caller cannot always reach it ─────────────────────────────
 *
 * 🔴 **The sampler used to be `while ($true)` with no way out except `stop()`.** `stop()` is reached
 * on the normal path and from `test.ts`'s `abort`, and that covers a lot — but not the paths that
 * matter most: a Ctrl+C (a signal terminates the parent without running any exit handler), an
 * uncaught throw, or a `process.exit` in code that never learned about `stop`. On Windows a spawned
 * child is in no job object, so it simply outlives its parent — and what it outlives it as is a
 * PowerShell process polling WMI at 5 Hz and appending to a temp file, forever, invisible to
 * `heavy-guard` (which does not match `powershell.exe`) and to `stray-servers` (no pattern for it).
 *
 * The condition that produces the orphan is a memory refusal, so **each leak makes the machine worse
 * at exactly the moment it was already in trouble**, and refusals repeat.
 *
 * ⚠️ **So the bound is a property of the LOOP, not of its caller.** Two of them, because they fail
 * differently:
 *
 *  · **Parent liveness**, checked every tick. The sampler exists to serve one process; when that
 *    process is gone there is nobody left to read the timeline. This stops an orphan within one
 *    200 ms tick, on every exit path there is, including the ones no handler can intercept.
 *  · **{@link MAX_TICKS}, an absolute ceiling.** PID reuse is real on Windows (`peak-sampler`'s own
 *    header records PID 12528 appearing twice in one gate), so a liveness test can be satisfied by a
 *    stranger wearing the dead parent's number. The ceiling is what makes "forever" unreachable
 *    regardless. It is set well above a `--full` gate (16–25 min) so it can never end a live run.
 *
 * `stop()` remains, and remains the fast path — these bounds are the floor under it, not a
 * replacement for it.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

export interface Sample {
  /**
   * Peak MB across the processes THIS window created, or undefined when it created none that were
   * ever seen alive. Excludes the runner, the runner's parent shim, and anything older than the
   * window — see the attribution note in this file's header.
   */
  readonly treeMb?: number
  /** Peak resident working set of those same attributed processes. Never feeds the commit planner. */
  readonly workingSetMb?: number
  /** Peak host commit charge as a percentage of the limit in the window, or undefined. */
  readonly hostCommitPct?: number
  /**
   * Peak MB of the `bun` processes this window EXCLUDED because they predate it.
   *
   * Reported so the exclusion is legible instead of asserted: on a normal gate this is the ~43 MB
   * `bun run test` shim, and a much larger figure here means something else was running.
   */
  readonly foreignMb?: number
  /**
   * How many timeline rows landed inside the window.
   *
   * ⚠️ **Without this, `treeMb === undefined` is two different facts wearing one face:** the sampler
   * never ticked here (dead child, unreadable file, a unit shorter than the interval), or it ticked
   * and the caller threw the number away. Measured 2026-08-07: `core` recorded `peakMb: null` on
   * three consecutive gates and the cause was the SECOND — 565 ticks, peak 16 758 MB — while the row
   * read exactly like the first. `ticks` is what tells them apart, and it is on the Sample rather
   * than inferred by the caller because only this function knows.
   */
  readonly ticks: number
  /**
   * How many of those rows actually SAW a process belonging to this window.
   *
   * ⚠️ `ticks` counts the sampler's heartbeat; `ownTicks` counts the measurement. A 300 ms unit gets
   * 2–4 heartbeats at a 200 ms interval and they can all land while its child is starting or already
   * gone — in which case a peak is a lower bound taken from one sample, not a measurement. Recorded
   * so a reader (and, later, a minimum-sample rule) can tell the difference.
   */
  readonly ownTicks: number
}

export interface Sampler {
  /** Peak values recorded between two `Date.now()` stamps. Empty when the window caught no tick. */
  readonly window: (fromMs: number, toMs: number) => Sample
  /** Stop sampling and clean up. Safe to call twice. */
  readonly stop: () => void
}

/** A sampler that measures nothing — used when the platform probe is unavailable. */
const INERT: Sampler = { window: () => ({ ticks: 0, ownTicks: 0 }), stop: () => {} }

/** 200 ms: fast enough that a sub-second unit still lands two or three ticks. */
const INTERVAL_MS = 200

/**
 * The absolute ceiling on a sampler's life, in ticks — one hour at {@link INTERVAL_MS}.
 *
 * Chosen against the longest run that exists: a `--full` gate is 16–25 minutes, so this cannot end a
 * live run, and it is the reason a PID-reuse false positive on the liveness check still cannot buy
 * the loop an unbounded life. Exported so the test can build a loop with a small one and watch it
 * stop, which is the only way to prove a bound rather than assert it.
 */
export const MAX_TICKS = (60 * 60 * 1000) / INTERVAL_MS

/**
 * One timeline row: `<tickMs> <hostCommitPct> [<pid>,<startMs>,<commitMb>,<workingSetMb> ...]`
 *
 * Per-PROCESS rather than a pre-summed total, because the sum is exactly the thing that cannot be
 * un-mixed later: once sixteen workers, a shim and a stray have been added together, no consumer can
 * tell them apart. The parent does the arithmetic, and can therefore do it per window.
 *
 * ⚠️ Plain `{0}` formatting, never `{0:N0}` — the old row used `N0` and emitted thousands separators
 * (`16,758`), which the reader then had to strip with a `[^\d]` regex. A comma is now a field
 * separator, so that formatting would silently split one process into three.
 */
export const WINDOWS_LOOP = (file: string, rootPid: number, maxTicks: number = MAX_TICKS) =>
  [
    `$f = '${file}'; $root = ${rootPid}; $maxTicks = ${maxTicks}; $tick = 0`,
    "while ($tick -lt $maxTicks) {",
    "  $tick = $tick + 1",
    // The self-bound — see the header. `-ErrorAction SilentlyContinue` because a dead pid is the
    // EXPECTED reading here, not an error, and a thrown one would leave the loop running.
    "  if (-not (Get-Process -Id $root -ErrorAction SilentlyContinue)) { break }",
    "  $ms = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()",
    "  $hc = 0",
    "  $o = Get-CimInstance Win32_OperatingSystem",
    "  if ($o.TotalVirtualMemorySize -gt 0) { $hc = [int](100 * ($o.TotalVirtualMemorySize - $o.FreeVirtualMemory) / $o.TotalVirtualMemorySize) }",
    // `Where-Object`/`foreach` rather than `-Filter "Name='bun.exe'"`: the filter needs embedded
    // double quotes, which do not survive being passed through `-Command` as one argument —
    // measured, and the symptom was a silent zero rather than an error.
    "  $parts = @()",
    "  foreach ($p in (Get-Process bun -ErrorAction SilentlyContinue)) {",
    "    if ($p.Id -eq $root) { continue }",
    // -1 = birth time unreadable (a protected process, or one that exited between the enumeration and
    // this read). The parser treats -1 as FOREIGN: never claim a process we cannot date.
    "    $st = -1",
    "    try { $st = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { $st = -1 }",
    "    $parts += ('{0},{1},{2},{3}' -f $p.Id, $st, [int]($p.PagedMemorySize64 / 1MB), [int]($p.WorkingSet64 / 1MB))",
    "  }",
    "  Add-Content -Path $f -Value ('{0} {1} {2}' -f $ms, $hc, ($parts -join ' ')) -ErrorAction SilentlyContinue",
    `  Start-Sleep -Milliseconds ${INTERVAL_MS}`,
    "}",
  ].join("\n")

/**
 * The POSIX arm, same row shape.
 *
 * ⚠️ **`etimes` has ONE-SECOND granularity, so the birth time here is the EARLIEST the process could
 * have been born** (`now - (etimes+1)s`), never the latest. That biases toward calling a process
 * foreign, which is the safe direction: an under-attributed unit reports a low peak, an
 * over-attributed one feeds the memory ladder a number that is not its own. ⚠️ Windows is the only
 * platform this has been exercised on (2026-08-07); on Linux the precise source would be
 * `/proc/<pid>/stat` field 22 against `/proc/uptime`, and that is the change to make when someone can
 * run it there rather than reason about it from here.
 */
export const POSIX_LOOP = (file: string, rootPid: number, maxTicks: number = MAX_TICKS) =>
  [
    `f='${file}'; root=${rootPid}; maxTicks=${maxTicks}; tick=0`,
    'while [ "$tick" -lt "$maxTicks" ]; do',
    "  tick=$((tick+1))",
    // The self-bound — see the header. `kill -0` tests for existence without signalling.
    '  kill -0 "$root" 2>/dev/null || break',
    "  now=$(date +%s%3N)",
    "  hc=0",
    "  if [ -r /proc/meminfo ]; then",
    "    hc=$(awk '/^MemTotal:/{t=$2} /^MemAvailable:/{a=$2} END{ if (t>0) print int(100*(t-a)/t); else print 0 }' /proc/meminfo)",
    "  fi",
    // POSIX has no trustworthy commit-charge equivalent here; RSS remains the documented proxy, so
    // both columns intentionally carry the same measured value on this arm.
    `  procs=$(ps -eo pid=,rss=,etimes=,comm= | awk -v root="$root" -v now="$now" '$4 ~ /(^|\\/)bun$/ && $1 != root { printf "%s,%s,%s,%s ", $1, now - ((int($3)+1)*1000), int($2/1024), int($2/1024) }')`,
    `  printf '%s %s %s\\n' "$now" "\${hc:-0}" "$procs" >> "$f"`,
    `  sleep ${INTERVAL_MS / 1000}`,
    "done",
  ].join("\n")

/** A number that survived parsing, or undefined. Keeps the NaN check in one place. */
const num = (s: string | undefined): number | undefined => {
  if (s === undefined) return undefined
  const n = Number(s)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Slice a timeline by a window and attribute each process in it.
 *
 * Pure, exported and tested (`peak-sampler.test.ts`) because this is where the whole correctness
 * claim lives — the PowerShell/sh loops only transcribe the process table, and a transcription bug
 * shows up as an empty row, while an attribution bug shows up as a plausible wrong number.
 *
 * A process belongs to the window when `startMs >= fromMs`. `startMs < 0` means the sampler could
 * not read it and the process is foreign by construction.
 */
export function attribute(timeline: string, fromMs: number, toMs: number): Sample {
  let treeMb = 0
  let workingSetMb = 0
  let foreignMb = 0
  let hostCommitPct = 0
  let ticks = 0
  let ownTicks = 0
  for (const line of timeline.split("\n")) {
    const fields = line.trim().split(/\s+/).filter(Boolean)
    const ts = num(fields[0])
    if (ts === undefined || ts < fromMs || ts > toMs) continue
    ticks++
    hostCommitPct = Math.max(hostCommitPct, num(fields[1]) ?? 0)
    let own = 0
    let ownWorkingSet = 0
    let foreign = 0
    let sawOwn = false
    for (const entry of fields.slice(2)) {
      const [, startRaw, mbRaw, workingSetRaw] = entry.split(",")
      const startMs = num(startRaw)
      const mb = num(mbRaw)
      const resident = num(workingSetRaw)
      // An entry we cannot parse is not silently dropped into "ours" — it is not counted at all, the
      // same treatment an undateable process gets, for the same reason.
      if (startMs === undefined || mb === undefined || resident === undefined) continue
      if (startMs >= 0 && startMs >= fromMs) {
        own += mb
        ownWorkingSet += resident
        sawOwn = true
      } else foreign += mb
    }
    if (sawOwn) ownTicks++
    treeMb = Math.max(treeMb, own)
    workingSetMb = Math.max(workingSetMb, ownWorkingSet)
    foreignMb = Math.max(foreignMb, foreign)
  }
  if (ticks === 0) return { ticks: 0, ownTicks: 0 }
  return {
    ticks,
    ownTicks,
    ...(treeMb > 0 ? { treeMb } : {}),
    ...(workingSetMb > 0 ? { workingSetMb } : {}),
    ...(foreignMb > 0 ? { foreignMb } : {}),
    ...(hostCommitPct > 0 ? { hostCommitPct } : {}),
  }
}

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
  // The caller's own cleanup is `stop()`; this is the one it cannot reach. An uncaught throw, or a
  // `process.exit` somewhere that never heard of this module, still runs `exit` listeners — and this
  // is also the only thing that removes the temp dir on those paths, since `stop()` owns that too.
  // ⚠️ It is a BACKSTOP, not the bound: a signal runs no listener at all, which is why the sampled
  // loop bounds itself (see the header).
  const onExit = () => sampler.stop()
  const sampler: Sampler = {
    window: (fromMs, toMs) => {
      let timeline: string
      try {
        timeline = readFileSync(file, "utf8")
      } catch {
        // An unreadable timeline is indistinguishable from an empty one to the caller, and both are
        // honestly "no tick reached me" — the distinction that mattered is measured-vs-discarded.
        return { ticks: 0, ownTicks: 0 }
      }
      return attribute(timeline, fromMs, toMs)
    },
    stop: () => {
      if (stopped) return
      stopped = true
      process.removeListener("exit", onExit)
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
  process.once("exit", onExit)
  return sampler
}
