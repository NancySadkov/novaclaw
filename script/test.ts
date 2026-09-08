#!/usr/bin/env bun
/**
 * `bun run test` — the everyday test suite. Fast, hermetic, and HANG-PROOF.
 *
 * Philosophy (AGENTS.md → Test-suite hygiene): the suite must stay runnable + green on every dev
 * machine (we are NOT Linux-only) and never freeze, so it gets run on every change. Tests that hung
 * or couldn't run from-source have been DELETED, not hidden — a hanging test is zero coverage plus a
 * liability. What remains here runs cleanly; the failures it still surfaces are tracked in todo.md
 * ("Test-suite hygiene") as cross-platform-hardening work, NOT swept under an ignore list.
 *
 * Bulletproofing: a uniform per-test `--timeout` fails a single stuck test; a per-package WALL-CLOCK
 * kill catches anything a per-test timeout can't (a wedged hook / forked fiber / leaked handle) — so
 * a NEW hang can never freeze the suite. If a package gets wall-clock-killed, that's a new crashed car
 * to find + delete (or a fixture leak to fix), not something to wait on.
 *
 *   bun run test              # typecheck every package, then the fast tier: kernel, schemas, LLM, SDK,
 *                             #   UI, desktop, server, HTTP contract
 *   bun run test --full       # RELEASE TIER ONLY (16-25 min) — a release cut, or a failure you
 *                             #   cannot explain from the diff. Not part of the dev loop.
 *   bun run test --only=core
 *   bun run test --only=typecheck   # just: does the tree compile (~52 s)
 *
 *   NOVACLAW_TEST_CONCURRENCY=1 bun run test   # the SERIAL arm, for an A/B against the pool
 *
 * ─── PHASE 2 RUNS A POOL, PHASE 1 DOES NOT ────────────────────────────────────────────────────────
 * Test units run several at a time, admitted against a memory budget measured while the pool was
 * empty; typechecks stay strictly one at a time (`tsgo` on `packages/novaclaw` peaks ~3.8 GB and
 * cannot be sharded). Why, how the budget is handed out, and what it costs the peak profile:
 * `lib/run-schedule.ts` and `lib/peak-series.ts`'s `PeakStatus`.
 *
 * ⚠️ novaclaw is `--full`: everything not promoted runs as ONE unit, plus a unit per file that cannot
 * share a process (`SOLO_TEST_FILES`). Why it is no longer one unit per subdir is recorded on
 * `subUnits` below, which is the code that decides it.
 *
 * ─── WHY A GREEN RUN MEANS SOMETHING ───────────────────────────────────────────────────────────────
 * The binding ruling is todo.md → Standing architecture decisions: *"a check that reads as coverage
 * while being none is worse than its absence"*. Two constraints follow that the code cannot state:
 *
 *  1. **The child's stderr is CAPTURED, never inherited.** `stdio: "inherit"` gives live output and
 *     leaves the summary with nothing but `exit <n>`, which is why core's intermittent `exit 3`
 *     (~1 run in 3) went un-root-caused for as long as it did. We capture stderr, echo it, and put an
 *     excerpt on the summary line. ⚠️ Do not "simplify" this back to `inherit` for the streaming.
 *  2. **A skip must be VISIBLE.** Several suites are platform-gated and nothing said so. The
 *     `── skipped ──` ledger below is asserted against a committed baseline, so a newly-skipped suite
 *     is a visible diff instead of a silent hole.
 *
 * ⚠️ **Trade-off you will notice:** a run unit's output appears in one burst when that unit FINISHES
 * rather than streaming line-by-line. bun's test reporter writes to **stderr**, which has always been
 * captured for the reason above; **stdout joined it when phase 2 became a pool**, because live output
 * from four units interleaved on one terminal is not liveness, it is a transcript nobody can read. A
 * `▶ <unit>` line still prints when a unit STARTS and each finished unit's output arrives under a
 * banner naming it, so both "what is running" and "who said this" survive.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { readFileSync } from "node:fs"
import os from "node:os"
import { join } from "node:path"

import { writeDiagnostic } from "./lib/diagnostic"
import { check, hostCommitPct, memoryHeadroom, topConsumers, type MemoryHeadroom } from "./lib/heavy-guard"
import { sweepStrayServers } from "./lib/stray-servers"
import * as LedgerDrift from "./lib/ledger-drift"
import * as CommitPressure from "./lib/commit-pressure"
import * as ChildExit from "./lib/child-exit"
import * as MemoryPlan from "./lib/memory-plan"
import * as PeakSampler from "./lib/peak-sampler"
import * as PeakSeries from "./lib/peak-series"
import * as RunSchedule from "./lib/run-schedule"
import { readFailingNames, readSkipCount, readTestCount, stripAnsi } from "./lib/test-output"
import { isUpstreamWatcherCrash } from "./lib/upstream-crash"
import { typecheckUnits } from "./lib/typecheck-units"
import {
  novaclawSubUnits,
  PACKAGES,
  PROMOTED_NOVACLAW_SUBDIRS,
  PROMOTED_NOVACLAW_TEST_FILES,
} from "./lib/run-units"

/**
 * Refuse to run alongside a build, local inference server or another suite, or on a machine whose
 * commit charge is already near its limit. No override, and a real measurement is required: tests
 * are evidence, so knowingly running one in conditions that can fabricate a timeout is never useful.
 *
 * The incident-derived 6 GB floor is replaced by the planner's measured one-runtime floor. This arm
 * remains absolute: below it no shard can start without sustained paging. Per-unit resident demand is
 * judged separately in `planSolo`; builds retain the conservative 6 GB default.
 *
 * 🔴 **It uses `check` and `abort`, never `enforce`, and that is the pool's doing.** `enforce`
 * prints and calls `process.exit(2)` — correct for a serial runner, which holds at most one child
 * and only ever checks between units. Called from `admitNext` with three units in flight it would
 * leave three `bun` processes with a dead parent: the multi-GB orphan AGENTS.md calls a death
 * spiral, created by the very guard that exists to prevent it. `abort` kills the pool by tree first.
 *
 * ⚠️ `ownWorkInFlight` narrows this to the FOREIGN-job arm; see `heavy-guard.ts` for why the
 * pressure arms measure us rather than the machine once the pool is holding it.
 */
const enforceTestMemory = (label: string, ownWorkInFlight = false) => {
  const verdict = check(process.argv, {
    allowOverride: false,
    requireMeasurement: true,
    minimumFreeBytes: MemoryPlan.MIN_VIABLE_BYTES,
    ownWorkInFlight,
  })
  if (verdict.ok) return
  abort(2, `\n\x1b[31mRefusing to start ${label}: ${verdict.reason}.\x1b[0m\n${verdict.detail ?? ""}\n\n`)
}

/**
 * Every `bun` this process currently owns, so a refusal can take its own work down with it.
 *
 * ⚠️ Declared HERE, above the first `enforceTestMemory` call, rather than beside `spawnOnce` where
 * it is filled: `abort` runs from the import-time guard too, and a `const` declared later would be
 * in its temporal dead zone — a refusal that throws a `ReferenceError` instead of refusing.
 */
const liveChildren = new Set<ChildProcess>()
/** Detached so `abort` can stop the sampler without referencing a `const` declared below it. */
let stopSampler: () => void = () => {}

// The owner's directive — "launching new bun or launching build kills existing buns" — reached
// `dev`, `dev:web` and the desktop prebuild but not the heaviest bun launch in the repo. Swept
// BEFORE the admission check below, so four idle `serve` backends make the gate proceed rather
// than refuse; `stray-servers.test.ts` pins that no heavy-guard label is ever a sweep target, which
// is what makes sweeping in front of a gate safe for a concurrent session's own run.
sweepStrayServers({ reason: "the test suite" })

enforceTestMemory("the test suite")

const FULL = process.argv.includes("--full")
// ⚠️ Owner directive 2026-09-02: `--full` is OFF the development loop — a release cut, or a failure
// you cannot explain from the diff and cannot reproduce in its own unit. Nothing here refuses the
// flag; the point is that the rule is visible where it is actually being spent, not only in a doc
// nobody re-reads mid-session (AGENTS.md principle 12: the mechanism ships with the rule).
if (FULL) {
  console.log("")
  console.log("  --full is the RELEASE tier (16-25 min). Off the development loop by owner directive:")
  console.log("  run it to cut a release, or for a failure you cannot explain from the diff.")
  console.log("  Otherwise `--only=<unit>` plus `--only=typecheck` is what a commit or a push needs.")
  console.log("")
}
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length)

const PER_TEST_TIMEOUT_MS = 15_000
const PACKAGE_WALLCLOCK_MS = 150_000 // a HANG backstop, not a normal budget
// Captured output is held in memory, per stream, per in-flight unit. `spawnSync` used to KILL the
// child on overflow and report ENOBUFS, which read exactly like a real failure; the async collector
// TRUNCATES and says so instead, so the ceiling now only bounds this process's own heap. It stays
// far above any plausible run (core's ~2k tests produce a few hundred KB).
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024
/**
 * Above this, a peak sample is not a reading about the unit — see `spawnOnce`.
 *
 * ⚠️ **It moved into `lib/memory-plan.ts` on 2026-08-07 and that is not tidying.** The ceiling and
 * the peak profile are one mechanism: a ceiling below an entry's true value discards exactly the
 * reading that entry needs, and the entry then cannot be learned. They now live in one file with
 * `MemoryPlan.unrecordableUnits` pinning them together. Re-declaring it here would let the pair
 * drift apart again, which is the defect that kept `core` at 1 007 MB while it cost ~17 000.
 */
const IMPLAUSIBLE_PEAK_MB = MemoryPlan.IMPLAUSIBLE_PEAK_MB

/**
 * Why a unit has no recorded peak.
 *
 * 🔴 **A bare `undefined` conflated two opposite facts and hid a live regression for three gates.**
 * `core` reported no peak on 2026-08-07 across four consecutive full runs, and the reason was
 * `discarded`, never `unsampled`: the sampler took 565 ticks in its window and peaked at 16 758 MB,
 * i.e. 2.05x the 8 192 MB ceiling of the day (core's OWN process was 7 381 MB against a 1 007 MB
 * profile; the rest was its own flock workers, which are `bun` because the tests spawn
 * `process.execPath`). "Nothing was measured" and "something enormous was measured and thrown away"
 * want opposite responses, and only the second is itself a finding — so the run must say which.
 *
 * ✅ **`core` is `measured` again as of the 2026-08-07 re-baseline** — the ceiling now clears its
 * real cost. This type stays exactly as it is: `discarded` was never a `core` special case, it is
 * what the reporting layer owes any reading it refuses.
 */
type PeakStatus = PeakSeries.PeakStatus

/**
 * What a run unit IS, because the two kinds report differently and must not be read as one another.
 *
 * A `typecheck` unit produces no bun summary at all, so both ledgers below have to skip it — a
 * typecheck row counted as "no bun summary — crashed or killed" would be this file describing a fault
 * falsely (todo.md ruling 2) on every single green run.
 */
type Kind = "test" | "typecheck"

/** One thing to spawn: everything the scheduler needs before it decides whether there is room. */
type Job = {
  readonly name: string
  readonly kind: Kind
  readonly dir: string
  readonly argv: string[]
  readonly wallclockMs: number
  /** Position in the planned order, carried onto the result so the summary can be stably sorted. */
  readonly order: number
}

type Result = {
  name: string
  kind: Kind
  /**
   * Where this unit sat in the order the run PLANNED, not the order it finished in.
   *
   * ⚠️ Needed the moment phase 2 became a pool: results are pushed as units complete, so a summary
   * printed in push order lists the fastest unit first and reshuffles itself between runs. Two
   * summaries of the same tree have to be diffable, so the report sorts on this.
   */
  order: number
  ok: boolean
  ms: number
  note: string
  /** Tests bun reported as skipped, or `undefined` when its summary could not be read (crash/kill). */
  skipped: number | undefined
  /** Total tests Bun reported as completed, or `undefined` when its final summary was unreadable. */
  testCount: number | undefined
  /** The names bun reported as failing, for the expected-failure ledger. */
  failing: string[]
  /** Peak MB this unit's processes held, when the sampler could measure it. Feeds the peak profile. */
  peakMb?: number
  /** Which of the three states above produced (or withheld) `peakMb`. */
  peakStatus?: PeakStatus
  /** What the sampler actually read, INCLUDING a reading that `peakMb` refused. See `PeakStatus`. */
  sampledMb?: number
  /** Resident working-set peak measured beside commit for the same attributed processes. */
  workingSetMb?: number
  /**
   * Peak MB of the `bun` processes the sampler EXCLUDED from this unit because they predate it.
   *
   * On a healthy gate this is the ~43 MB `bun run test` shim that used to be added into every unit's
   * peak. Recorded so the exclusion is a printed number rather than a claim in a comment.
   */
  foreignMb?: number
  /** Ticks that actually saw one of this unit's processes — see `PeakSampler.Sample.ownTicks`. */
  ownTicks?: number
  /**
   * Ticks the sampler took inside this unit's window at all, whoever they belonged to.
   *
   * ⚠️ Carried because attribution created a THIRD kind of no-peak, and the rule that a null must say
   * which null applies to it too: `ticks > 0 && ownTicks === 0` means the sampler was alive and
   * looking and this unit owned nothing it saw — a sub-second unit whose child fits between two
   * heartbeats. That is a different fact from `ticks === 0` (the sampler was not there), and only the
   * second is an instrument failure.
   */
  ticks?: number
  /** How many shards this unit was split into, when memory pressure forced the degraded rung. */
  shards?: number
}
const results: Result[] = []

/**
 * A tsgo diagnostic: `src/foo.ts(3,31): error TS4104: The type 'readonly string[]' is 'readonly' ...`.
 * Neither of the other two shapes below matches one, and tsgo's LAST line is often a bare count, so
 * without this a failing typecheck's summary row said `exit 2` and named no file.
 */
const TS_DIAGNOSTIC = /\berror TS\d+\b/

/** The most actionable single line we can put on a summary row. */
function failureExcerpt(output: string): string {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const pick =
    lines.find((line) => TS_DIAGNOSTIC.test(line)) ??
    lines.find((line) => /^error[:\s]/i.test(line)) ??
    lines.find((line) => line.includes("(fail)")) ??
    lines.at(-1)
  if (!pick) return ""
  return pick.length > 140 ? `${pick.slice(0, 137)}...` : pick
}

/**
 * Reap what a wall-clock kill leaves behind.
 *
 * ⚠️ THIS IS NOT HOUSEKEEPING — without it the suite poisons its own later runs. `spawnSync`'s
 * `timeout` kills the process it spawned, but `bun test` is a PARENT+CHILD pair sharing one command
 * line (AGENTS.md → Known pitfalls #8), so the SIGKILL lands on the parent and the child survives.
 * Observed 2026-07-27: one killed `novaclaw:server` left a bun child holding **4.89 GB**; reaping it by
 * hand dropped commit charge from 42.1 GB to 30.2 GB on a 44.7 GB limit.
 *
 * That is a death spiral, and the measurements show it running: each leaked child made the box slower,
 * which pushed the next unit past ITS wall clock, which leaked another child. `novaclaw:server` went
 * 95s → 114s → 242s → killed at 300s, and `core` crashed outright on the run after that.
 *
 * Matching is by PARENT PID, not by command line: the survivor keeps `proc.pid` as its recorded parent
 * even after that parent dies, which identifies it exactly. A command-line match would risk killing an
 * intentional long-lived `bun` (a dev server, a `novaclaw serve`) that merely looked similar.
 *
 * 🔴 **It also RECORDS what it reaped, and that is a diagnostic rather than decoration.** A unit
 * killed on the wall clock reports which pids survived and nothing about what they were, so a hang
 * whose cause is a leaked child names no subsystem at all. `bun` cannot supply the missing half: it
 * prints a test file's output only when that file FINISHES, so the file that never finishes is the
 * one that never prints, and three ways of asking it for the executing file were tried on 2026-09-04
 * and none exists (`expect.getState`, a preload `beforeAll` plus stack, a `Bun.plugin` onLoad).
 *
 * The command line is the one identifying detail the harness can get WITHOUT bun's cooperation. The
 * CIM query already runs; asking it for a second column costs nothing, and the next wall-clock kill
 * says `git.exe clone …` or `bun … some.test.ts` instead of a bare number.
 */
function reapOrphans(pid: number | undefined, label: string) {
  if (pid === undefined) return
  const survivors: number[] = []
  /** pid -> what it was running, so the report names a subsystem and not just a number. */
  const command = new Map<number, string>()
  if (process.platform === "win32") {
    const probe = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { ` +
          `$_.ProcessId.ToString() + '|' + $_.CommandLine }`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    )
    for (const line of (probe.stdout ?? "").split(/\r?\n/)) {
      const [head, ...rest] = line.trim().split("|")
      const child = Number(head)
      if (!Number.isFinite(child) || child <= 0) continue
      survivors.push(child)
      if (rest.length) command.set(child, rest.join("|"))
    }
  } else {
    const probe = spawnSync("pgrep", ["-P", String(pid), "-a"], { encoding: "utf8", timeout: 20_000 })
    for (const line of (probe.stdout ?? "").split("\n")) {
      const [head, ...rest] = line.trim().split(" ")
      const child = Number(head)
      if (!Number.isFinite(child) || child <= 0) continue
      survivors.push(child)
      if (rest.length) command.set(child, rest.join(" "))
    }
  }
  if (!survivors.length) return
  for (const child of survivors) {
    // By TREE, never a bare pid: the survivor may itself have spawned MCP node servers.
    if (process.platform === "win32")
      spawnSync("taskkill", ["/T", "/F", "/PID", String(child)], { stdio: "ignore", timeout: 20_000 })
    else {
      try {
        process.kill(-child, "SIGKILL")
      } catch {
        try {
          process.kill(child, "SIGKILL")
        } catch {
          /* already gone */
        }
      }
    }
  }
  // The command line is TRUNCATED, not dropped: a bun test child's argv carries the whole shard's
  // file list, which would bury the one line that matters. The head names the binary and its first
  // arguments, which is what identifies the subsystem.
  const describe = (child: number) => {
    const line = command.get(child)
    if (!line) return String(child)
    return `${child} (${line.length > 160 ? `${line.slice(0, 160)}…` : line})`
  }
  process.stderr.write(
    `  \x1b[33mreaped ${survivors.length} orphaned child process(es) left by the ${label} kill:\x1b[0m\n` +
      survivors.map((child) => `    \x1b[33m${describe(child)}\x1b[0m\n`).join(""),
  )
}

/**
 * Spawn one run unit and record what it did. `argv` is the FULL argument list to `bun` — `["test", …]`
 * for a suite, `["run", "typecheck"]` for a typecheck.
 *
 * ⚠️ The two kinds write their diagnostics to DIFFERENT streams, measured 2026-07-28:
 *   - bun's test reporter writes to **stderr** (stdout stays inherited so a test's own `console.log`
 *     still streams live);
 *   - `tsgo` writes its diagnostics to **stdout** and exits **2**, with stderr empty.
 * So a typecheck unit must pipe stdout as well, or a failing typecheck reports `exit 2` with no file,
 * no line and the "nothing was captured" note — a failure we cannot read is a failure we cannot fix
 * (the same reason stderr stopped being thrown away; see the header). Typecheck units are 0.3–21 s, so
 * losing per-line liveness there costs nothing.
 *
 * Invoking `bun run typecheck` rather than `tsgo` directly is deliberate: each package's own script is
 * the single source of truth for how it is checked (`app` needs `tsgo -b`, `desktop` needs two passes),
 * and a package that changes its command does not have to change this file.
 */
/**
 * The peak profile: what each unit was last MEASURED to cost, in MB.
 *
 * Read separately (and very tolerantly) from the full baseline below, because the ladder needs it
 * before the first unit runs while the ledgers are only read at the end. An unreadable or absent
 * profile is the unprofiled state, not a fault: every unit then plans with the generous default.
 */
function readPeaks(): {
  commit: MemoryPlan.PeakProfile
  resident: MemoryPlan.PeakProfile
  /** Units whose absence from `peaks` is a DECISION — see `peaksUnsampledNote` in the baseline. */
  deliberatelyAbsent: ReadonlySet<string>
  /** Per-unit host-commit warning lines; units absent from it use `HOST_COMMIT_WARN_PCT`. */
  hostCommitWarnPct: Record<string, number>
} {
  try {
    const parsed = JSON.parse(readFileSync(join(import.meta.dir, "test-baseline.json"), "utf8")) as {
      peaks?: Record<string, number>
      workingSets?: Record<string, number>
      peaksDeliberatelyAbsent?: string[]
      hostCommitWarnPct?: Record<string, number>
    }
    const valid = (values: Record<string, number> | undefined) =>
      Object.fromEntries(Object.entries(values ?? {}).filter(([, mb]) => Number.isFinite(mb) && mb > 0))
    return {
      commit: valid(parsed.peaks),
      resident: valid(parsed.workingSets),
      deliberatelyAbsent: new Set(parsed.peaksDeliberatelyAbsent ?? []),
      hostCommitWarnPct: valid(parsed.hostCommitWarnPct),
    }
  } catch {
    return { commit: {}, resident: {}, deliberatelyAbsent: new Set(), hostCommitWarnPct: {} }
  }
}
const peakProfiles = readPeaks()

/** Every unit name this invocation could run — the candidate list for "what would still fit". */
const allUnitNames = () => PACKAGES.map((p) => p.name)

/**
 * What a unit is expected to cost. Split out of `planUnit` because the POOL needs the demand without
 * the plan: a reservation is `requiredBytes(demand)`, and the plan is only consulted when the unit
 * is alone (the only state in which sharding or refusing is the right answer).
 */
function demandOf(name: string, kind: Kind): MemoryPlan.Demand {
  // A typecheck is a different beast — `tsgo --noEmit` on `packages/novaclaw` peaks ~3.8 GB and
  // cannot be sharded at all — so it keeps the conservative floor rather than this ladder.
  return kind === "typecheck"
    ? { commitPeakMb: 4096, residentPeakMb: 4096 }
    : MemoryPlan.demandFor(peakProfiles.commit, peakProfiles.resident, name)
}

/** Fail closed, exactly as `requireMeasurement` does: an unmeasurable host is not a safe one. */
function headroomOrRefuse(name: string, kind: Kind): MemoryHeadroom {
  const headroom = memoryHeadroom()
  if (headroom !== undefined) return headroom
  abort(
    2,
    `\n\x1b[31mRefusing to start ${kind} unit ${name}: host memory could not be measured.\x1b[0m\n` +
      `Neither free RAM nor Windows commit charge could be read, so the harness would only be\n` +
      `guessing that this unit fits.\n\n`,
  )
}

/**
 * Decide the rung for one unit ALONE, or refuse with something the reader can act on.
 *
 * ⚠️ This REPLACES the flat 6 GB free-RAM floor for tests. The reasoning, and the measurements it
 * rests on, are in `lib/memory-plan.ts` and `notes/test-harness-memory.md`.
 *
 * ⚠️ **Only ever called with an EMPTY pool**, which is what keeps its arithmetic honest: `headroom`
 * is then a live reading of a machine holding none of our work, i.e. the same measurement this
 * function made when the runner was serial. Deciding a rung beside three in-flight units would read
 * their memory as the machine's and shard everything.
 */
function planSolo(name: string, kind: Kind, headroom: MemoryHeadroom): MemoryPlan.Plan {
  const demand = demandOf(name, kind)
  const plan = MemoryPlan.planFor(demand, headroom)
  if (plan.mode !== "refuse") return plan

  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
  const fits = MemoryPlan.unitsThatFit(peakProfiles.commit, peakProfiles.resident, allUnitNames(), headroom)
  const consumers = topConsumers()
  abort(
    2,
    `\n\x1b[31mRefusing to start ${kind} unit ${name}: the machine cannot fit it, even split.\x1b[0m\n` +
      `  commit  ${gb(plan.commitRequiredBytes)} needed / ${gb(headroom.commitBytes)} available` +
      `  (peak ${demand.commitPeakMb} MB)\n` +
      `  resident ${gb(plan.residentRequiredBytes)} needed / ${gb(headroom.residentBytes)} available` +
      `  (peak ${demand.residentPeakMb} MB)\n` +
      `  sharded ${gb(MemoryPlan.MIN_VIABLE_BYTES)}  (one shard's floor — peak is nearly flat in file count,` +
      ` so splitting harder does not help)\n` +
      (consumers.length ? `  holding it: ${consumers.join(", ")}\n` : "") +
      (fits.length
        ? `  still fits right now: bun run test --only=${fits[0]}${fits.length > 1 ? `  (+${fits.length - 1} more)` : ""}\n`
        : "") +
      `\n`,
  )
}

/**
 * ONE sampler for the whole suite, started before the first unit — see `lib/peak-sampler.ts` for why
 * per-unit sampling measured nothing for anything that finished in under a second.
 */
const sampler = PeakSampler.start()
stopSampler = sampler.stop

/**
 * ONE stamp for the whole invocation, taken where the work starts.
 *
 * There was no run id anywhere in this file before, which is why the peak block below could only ever
 * describe the run in hand — every row of the series carries this, so "one run" is a `grep` rather
 * than a guess about which lines arrived together. `Date.now()` is enough: nothing correlates these
 * rows with anything outside this process.
 */
const RUN_STAMP = new Date().toISOString()

/**
 * Kill everything we own, by TREE, then leave. Used by EVERY refusal path in this file.
 *
 * ⚠️ **`spawnSync` used to make this unnecessary and the pool makes it load-bearing.** A synchronous
 * runner holds exactly one child, and a memory refusal's `process.exit(2)` only ever happened
 * between units. A pool can be holding three when the fourth is refused — and exiting there would
 * leave three `bun` processes with a dead parent, which is precisely the multi-GB orphan AGENTS.md
 * calls a death spiral. A guard that leaks what it was protecting the machine from is not a guard.
 *
 * 🔴 **The diagnostic is a PARAMETER, and that is the whole point of the signature.** Every caller
 * here used to print its refusal and then call this — the pattern the footer of this file forbids,
 * on the four paths where the printed text is the only output the run produces. Folding the write in
 * means the wrong shape no longer typechecks: there is no way to reach this exit without handing it
 * the text, and no way to hand it the text except synchronously (`writeDiagnostic`). See
 * `lib/diagnostic.ts` for what was measured about the truncation itself — less than the rule claimed.
 */
function abort(code: number, diagnostic: string): never {
  writeDiagnostic(diagnostic)
  for (const child of liveChildren) {
    killTree(child)
    reapOrphans(child.pid, "shutdown")
  }
  stopSampler()
  process.exit(code)
}

/**
 * Kill a child AND everything it spawned.
 *
 * 🔴 **`child.kill()` is not enough here and the difference cost a 36-minute hang.** `bun test` is a
 * parent+child pair sharing one command line, so a signal aimed at the one we spawned leaves the
 * other alive — that is `reapOrphans`'s whole reason for existing. Reaping AFTERWARDS was adequate
 * while the runner blocked on `spawnSync`; it is not adequate now, because the survivor inherits the
 * pipe write ends and the wait for `close` never returns, so the code that would have reaped it is
 * never reached. Killing the tree in one call removes the window instead of cleaning up after it.
 */
function killTree(child: ChildProcess) {
  if (child.pid === undefined) return
  if (process.platform === "win32")
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", timeout: 20_000 })
  else
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
}

/**
 * How long a wall-clock kill may take before the runner stops waiting for it and moves on.
 *
 * ⚠️ **A hang backstop that can itself hang is worse than none**, and that is exactly what the first
 * async runner shipped: the 600 s timer fired, killed `core`'s direct child, and then waited forever
 * on a grandchild holding 14.6 GB. `awaitChildExit` closes the ordinary version of that hole;
 * this closes the rest of it. Once we have decided to kill, we own a deadline, and no event from the
 * child — or absence of one — may extend it.
 */
const KILL_DEADLINE_MS = 10_000

/**
 * Accumulate a child's output with a CEILING, and say so rather than dying at it.
 *
 * ⚠️ This replaces `spawnSync`'s `maxBuffer`, and the replacement is strictly better in the way that
 * matters: `spawnSync` KILLS the child on overflow and reports `ENOBUFS`, which reads on the summary
 * line exactly like a real failure. Truncating a log cannot fail a test; killing the test can.
 */
function collector(limit: number) {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  return {
    push: (chunk: Buffer) => {
      if (bytes >= limit) {
        truncated = true
        return
      }
      chunks.push(chunk)
      bytes += chunk.length
    },
    get truncated() {
      return truncated
    },
    text: () =>
      Buffer.concat(chunks).toString("utf8") +
      (truncated ? `\n  (output truncated at ${limit / 1024 / 1024} MB — the child was NOT killed)\n` : ""),
  }
}

/** One spawn of one command, with its peak sampled. The unit-level orchestration is in `run`. */
async function spawnOnce(name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number) {
  const start = Date.now()
  const out = collector(CAPTURE_MAX_BYTES)
  const err = collector(CAPTURE_MAX_BYTES)
  let timedOut = false
  let spawnErrno: string | undefined
  // Run the interpreter that is executing this harness. On Windows `bun` may be available only as
  // a PowerShell shim (`bun.ps1`), which `child_process.spawn` does not resolve as an executable;
  // `process.execPath` is the real bun.exe on every supported host and cannot drift from the parent.
  const child = spawn(process.execPath, argv, { cwd: dir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  liveChildren.add(child)
  child.stdout?.on("data", out.push)
  child.stderr?.on("data", err.push)
  // Our own timer rather than spawn's `timeout` option: the kill has to be OURS anyway (it must be
  // a TREE kill — a bun test parent/child pair survives a signal aimed at the parent), and an
  // explicit timer is the one thing here that can be reasoned about without trusting node compat.
  let abandon: (outcome: ChildExit.ChildOutcome) => void = () => {}
  const abandoned = new Promise<ChildExit.ChildOutcome>((resolve) => {
    abandon = resolve
  })
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
    // ⚠️ The second timer is the part that was missing, not the kill. See `KILL_DEADLINE_MS`.
    setTimeout(() => abandon({ status: null, drained: false }), KILL_DEADLINE_MS).unref?.()
  }, wallclockMs)
  // Why this is not `await new Promise(r => child.once("close", r))` — which is what it was, and
  // which hung the gate for 36 minutes — is the whole subject of `lib/child-exit.ts`.
  const exit = await Promise.race([ChildExit.awaitChildExit(child), abandoned])
  clearTimeout(timer)
  liveChildren.delete(child)
  const status = exit.status
  spawnErrno = exit.errno

  const ms = Date.now() - start
  const stdoutText = out.text()
  // ⚠️ The PARSED surface stays stderr-only for a test unit, exactly as it was when stdout was
  // inherited. `readFailingNames` and `readSkipCount` scan this string, and folding a test's own
  // `console.log` into it would let printed prose be read as bun's summary.
  const captured = kind === "test" ? err.text() : `${stdoutText}${err.text()}`
  const errno = spawnErrno
  const ok = !timedOut && errno === undefined && status === 0

  // A killed or crashed child can leave its own child alive holding gigabytes. Reap before the next
  // unit starts, or the leak makes THAT unit slower and the failure cascades. See reapOrphans above.
  if (!ok) reapOrphans(child.pid, timedOut ? "wall-clock" : `exit ${status}`)

  // ⚠️ **The banner is unconditional now, and that is the pool's doing.** With one unit at a time an
  // output block could be read as belonging to the `▶ <unit>` line above it; with four in flight
  // that adjacency is gone and an unlabelled block belongs to nobody.
  const printed = kind === "test" ? `${stdoutText}${captured}` : captured
  process.stderr.write(
    `\n${ok ? "\x1b[2m" : "\x1b[31m"}── ${name} · ${(ms / 1000).toFixed(1)}s · ${ok ? "output" : "FAILED"} ──\x1b[0m\n`,
  )
  if (printed) process.stderr.write(printed.endsWith("\n") ? printed : `${printed}\n`)
  else if (!ok)
    process.stderr.write(
      `  (nothing was captured — bun BLOCK-BUFFERS redirected output, so a child killed mid-run usually\n` +
        `   flushes nothing. Silence here is a property of the kill, not evidence the child was quiet.)\n`,
    )

  // Annotated, not inferred: the false branch is a bare literal, and letting the union widen is how a
  // later field silently stops being reachable on one arm.
  // ⚠️ `start` is BOTH the window's left edge and the attribution cutoff, and that is the whole point:
  // a process born at or after this stamp was created by this spawn, and everything older — the
  // runner's `bun run test` parent shim, the previous unit's dying child, a stray — is somebody
  // else's. See `peak-sampler.ts`'s header for why ancestry and PID-set membership both failed here.
  const sample: PeakSampler.Sample = kind === "test" ? sampler.window(start, Date.now()) : { ticks: 0, ownTicks: 0 }

  let note = ""
  // ⚠️ **Kill-on-breach, measuring phase.** `todo/test-speed.md` asks for runtime enforcement and
  // says in the same breath to design it against the FALSE-KILL hazard first — core's wall-clock
  // backstop already fired on healthy runs, and a kill is indistinguishable from a crash in a
  // summary row. So the breach is REPORTED before anything is ever terminated on it.
  //
  // The gap this closes is narrow and real: `hostCommitPct` is read below only when a unit was
  // ALREADY killed, to tell paging from a hang. A unit that ran green at 96% commit — one bad
  // neighbour away from the 2026-07-20 OOM that took the laptop down — said nothing at all.
  //
  // The two lines are not new numbers. 75% is `heavy-guard.ts`'s admission line and the product's
  // own `Pressure` warning; 90% is the product's floor (`storage/pressure.ts` DEFAULT_THRESHOLDS).
  // One vocabulary across the gate and the app, so a breach here reads the same as a breach there.
  // Enable a kill only after these lines have been observed across several full gates — a ceiling
  // justified by one run inherits that run's expiry date.
  // The judgement — which readings deserve a line — lives in `lib/commit-pressure.ts`, where it is
  // pure and tested. A unit that legitimately runs hot carries its own line in the baseline.
  const pressure = CommitPressure.pressureLine(
    sample.hostCommitPct,
    peakProfiles.hostCommitWarnPct[name] ?? CommitPressure.HOST_COMMIT_WARN_PCT,
  )
  if (pressure) note = pressure.text
  if (timedOut) {
    // ⚠️ A wall-clock kill and a paging stall are indistinguishable in a summary row, and the second
    // is the FALSE FAILURE the memory guard exists to prevent — so when it happens anyway, say which
    // it was. The sampler already holds the answer; without this the reader hunts a hang that is not
    // there (which is exactly how 2026-07-27's cascade was misread for a week).
    const pressure =
      sample.hostCommitPct !== undefined && sample.hostCommitPct >= 90
        ? ` — host commit peaked ${sample.hostCommitPct}%, so this is likely PAGING rather than a hang`
        : sample.hostCommitPct !== undefined
          ? ` — host commit peaked only ${sample.hostCommitPct}%, so this is a genuine hang, not memory`
          : ""
    note = `WALL-CLOCK KILL at ${wallclockMs / 1000}s${pressure} (a SIGKILLed bun child often flushes no stderr)`
  } else if (errno) {
    note = `could not run bun: ${errno}`
  } else if (!ok) {
    const excerpt = failureExcerpt(captured)
    note = `exit ${status}${excerpt ? ` · ${excerpt}` : ""}`
  }
  // ⚠️ Truncation is a NOTE, never a failure, and it used to be the opposite: `spawnSync`'s
  // `maxBuffer` killed the child and reported `ENOBUFS`, which was indistinguishable from a real
  // red on the summary row. A green unit that printed too much stays green and says it printed too
  // much.
  if (out.truncated || err.truncated)
    note = [note, `output truncated at ${CAPTURE_MAX_BYTES / 1024 / 1024} MB (the child ran to completion)`]
      .filter(Boolean)
      .join(" · ")
  // ⚠️ A capture whose pipes never drained is SHORT, and saying so is the difference between a log
  // and a claim: something outlived this child still holding the write end, so what was collected is
  // whatever had arrived by the grace deadline. Never present that as a whole log.
  if (!exit.drained)
    note = [note, `a leaked child held the pipes open — this output may be INCOMPLETE`].filter(Boolean).join(" · ")

  // ⚠️ Discard a sample nothing on this machine could plausibly have produced.
  //
  // ⚠️ **What this ceiling means CHANGED on 2026-08-07 and the old reading of it was the bug.** It
  // used to guard a sum of every `bun` on the box, where a dev server or a stray from a killed run
  // was indistinguishable from the unit — and it was that guard, not a blind sampler, that made
  // `core` report `peakMb: null` for four consecutive gates: core's own sixteen flock workers are
  // `bun`, so its tree summed to 16 758 MB and was thrown away whole. The sample is now attributed by
  // process birth time, so a stray older than the unit never reaches here at all. What remains is a
  // sanity bound on OUR OWN processes, and a reading above it is now a finding about the unit rather
  // than a suspicion about the box.
  //
  // ⚠️ **The discard is not silent.** Dropping the number and leaving no trace is what made `core`'s
  // 16 758 MB read as "not measured"; the reading is reported as `sampledMb` whatever the verdict,
  // and only `peakMb` is withheld.
  const peakStatus: PeakStatus =
    sample.treeMb === undefined ? "unsampled" : sample.treeMb > IMPLAUSIBLE_PEAK_MB ? "discarded" : "measured"
  return {
    ok,
    ms,
    note,
    captured,
    upstreamCrash: kind === "test" && !ok && !timedOut && isUpstreamWatcherCrash(status, captured),
    peakStatus,
    ownTicks: sample.ownTicks,
    ticks: sample.ticks,
    ...(sample.treeMb !== undefined ? { sampledMb: sample.treeMb } : {}),
    ...(sample.workingSetMb !== undefined ? { workingSetMb: sample.workingSetMb } : {}),
    ...(sample.foreignMb !== undefined ? { foreignMb: sample.foreignMb } : {}),
    // ⚠️ RECORDED, not just printed. This block's own comment says to enable a kill "only after
    // these lines have been observed across several full gates" — and the observation was being
    // thrown away, so that precondition could never be met by anyone. It was computed, used for a
    // note when >=75%, and discarded. Persisting it makes the threshold decision answerable from
    // data instead of from one run's impression.
    ...(sample.hostCommitPct !== undefined ? { hostCommitPct: sample.hostCommitPct } : {}),
    ...(peakStatus === "measured" ? { peakMb: sample.treeMb } : {}),
  }
}

/**
 * `spawnOnce`, retried ONCE when the child died of the upstream watcher segfault.
 *
 * ⚠️ **The retry is announced, never silent.** A gate that quietly re-runs is a gate you cannot
 * trust: the reader has to be able to see that a unit needed two attempts, both because the
 * frequency is itself data (it rose sharply on 2026-08-06) and because a retry that hides itself
 * would eventually hide something else. The note travels onto the summary row.
 *
 * ⚠️ Exactly one retry. If the crash is no longer intermittent the gate must go red and say so,
 * rather than looping until it gets the answer it wants.
 */
async function spawnWithUpstreamRetry(name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number) {
  const first = await spawnOnce(name, kind, dir, argv, wallclockMs)
  if (!first.upstreamCrash) return first
  process.stderr.write(
    `\n\x1b[33m── ${name}: upstream Bun watcher segfault (exit 3, watcher.node, no failing assertions)\n` +
      `   — this is not your change; retrying ONCE. See todo.md's header.\x1b[0m\n`,
  )
  const second = await spawnOnce(name, kind, dir, argv, wallclockMs)
  return {
    ...second,
    note: second.ok
      ? `passed on retry after an upstream watcher segfault`
      : `${second.note} · (also crashed on the first attempt)`,
  }
}

/**
 * How much host commit is too much to START another unit on.
 *
 * 🔴 MEASURED, and the measurement rules out the obvious number. Across 17 full gates and 348 unit
 * rows, `core` runs at a MEDIAN of 74% and reaches 80%; every other unit tops out at 64%. So 75% —
 * `heavy-guard`'s admission line and the product's own warning — is `core`'s ordinary operating
 * point, and enforcing anything there would fire on roughly half of all healthy runs. A threshold
 * that fires on the normal case is not a threshold.
 *
 * 90% is the product's FLOOR (`storage/pressure.ts`), and it has never been observed here: zero rows
 * of 348. That is the point — it is a line for territory this box has not entered, not a tuning
 * knob. ⚠️ It therefore also cannot be validated by waiting for it to happen, which is why
 * `NOVACLAW_TEST_FORCE_COMMIT_PCT` exists.
 */
const COMMIT_FLOOR_PCT = CommitPressure.COMMIT_FLOOR_PCT
/** How long to let the host recover before giving up and running anyway. */
const COMMIT_FLOOR_WAIT_MS = 60_000

/**
 * Before starting a unit, let the previous one's memory come back.
 *
 * ⚠️ This is ADMISSION, not shedding — it cannot help a unit already holding memory, and
 * `todo/resource-pressure.md` is right that the missing level is enforcement against work in flight.
 * What it does buy is the compounding case, which is the one that took the laptop down on
 * 2026-07-20: a unit starting while the host is already at the floor.
 *
 * ⚠️ It WAITS rather than refuses. A gate that stops running tests because the machine is busy has
 * turned a resource problem into an unmeasured suite, which is worse; after the wait it proceeds and
 * says so.
 *
 * ⚠️ **Only with an EMPTY pool.** Waiting is the right answer when nothing of ours is running,
 * because time is all that can help. With units in flight the floor is a REFUSAL TO ADMIT instead
 * (`admitNext`): the thing that will clear the pressure is a unit finishing, and the scheduler is
 * already waiting for exactly that — a second wait inside it would just be a slower version of the
 * same wait, taken with the queue head pinned.
 */
// A forcing knob, because a line nobody has crossed is a line nobody has seen work. Set it to a
// number at or above the floor and the wait must engage — that is how this was verified at all.
function readCommitPct(): number | undefined {
  const forced = Number(process.env.NOVACLAW_TEST_FORCE_COMMIT_PCT)
  return Number.isFinite(forced) && forced > 0 ? forced : hostCommitPct()
}

async function waitForCommitFloor(name: string, kind: Kind) {
  const read = readCommitPct
  const first = read()
  if (first === undefined || first < COMMIT_FLOOR_PCT) return
  const deadline = Date.now() + COMMIT_FLOOR_WAIT_MS
  process.stderr.write(
    `\n\x1b[33mhost commit ${first}% is at or above the ${COMMIT_FLOOR_PCT}% FLOOR — holding ${kind} unit ${name}\x1b[0m\n` +
      `  Waiting up to ${COMMIT_FLOOR_WAIT_MS / 1000}s for the previous unit's memory to be reclaimed.\n` +
      topConsumers()
        .map((line) => `  ${line}\n`)
        .join(""),
  )
  while (Date.now() < deadline) {
    // ⚠️ `Bun.sleep`, not `Bun.sleepSync`. This function used to run with nothing else in flight, so
    // blocking the loop cost only time; it now runs while a pool of units is streaming output into
    // this process, and a synchronous sleep would stall their pipes for a minute.
    await Bun.sleep(2_000)
    const now = read()
    if (now === undefined || now < COMMIT_FLOOR_PCT) {
      process.stderr.write(`  host commit fell to ${now ?? "unknown"}% — starting ${name}\n`)
      return
    }
  }
  // Said loudly, and it is NOT a failure: the run continues, but a reader comparing this unit against
  // its history has to know the host was under pressure the whole time it ran.
  process.stderr.write(
    `  \x1b[33mstill at or above the floor after ${COMMIT_FLOOR_WAIT_MS / 1000}s — starting ${name} anyway; ` +
      `treat its timings and peak as measured under PRESSURE\x1b[0m\n`,
  )
}

/**
 * Run one unit: pick the rung from measured headroom, spawn it whole or in shards, record what it did.
 *
 * ⚠️ **A SHARDED result is weaker than a whole one and is labelled as such everywhere it appears.**
 * Splitting changes which files share a process, and that changes behaviour — measured 2026-08-05,
 * eight green batches over `core` concealed a wedge that only exists when the unit runs whole. The
 * fallback exists so a memory-poor machine gets most of the signal, never so it can claim the gate.
 */
async function run(job: Job, sharded: number | undefined, overlapped: () => boolean) {
  const { name, kind, dir, argv, wallclockMs } = job
  // ⚠️ **Shards stay SEQUENTIAL, and that is not an oversight left over from `spawnSync`.** The
  // sharded rung exists to lower a unit's memory demand; running its shards at once would restore
  // exactly the demand it was reached for. Concurrency is between INDEPENDENT units, which is where
  // the budget can actually account for it.
  const runs: Awaited<ReturnType<typeof spawnWithUpstreamRetry>>[] = []
  if (sharded)
    for (let i = 0; i < sharded; i++)
      runs.push(
        await spawnWithUpstreamRetry(
          `${name} shard ${i + 1}/${sharded}`,
          kind,
          dir,
          [...argv, `--shard=${i + 1}/${sharded}`],
          wallclockMs,
        ),
      )
  else runs.push(await spawnWithUpstreamRetry(name, kind, dir, argv, wallclockMs))

  const captured = runs.map((r) => r.captured).join("\n")
  // A skip count is only meaningful if EVERY shard produced a summary — one unreadable shard makes the
  // total an undercount, which the ledger would then read as a skip that disappeared.
  const perShardSkips = kind === "test" ? runs.map((r) => readSkipCount(r.captured)) : []
  const perShardCounts = kind === "test" ? runs.map((r) => readTestCount(r.captured)) : []
  const skipped =
    kind !== "test" || perShardSkips.some((s) => s === undefined)
      ? undefined
      : perShardSkips.reduce<number>((a, s) => a + (s ?? 0), 0)
  const testCount =
    kind !== "test" || perShardCounts.some((count) => count === undefined)
      ? undefined
      : perShardCounts.reduce<number>((a, count) => a + (count ?? 0), 0)
  const peaks = runs.map((r) => r.peakMb).filter((mb): mb is number => mb !== undefined)
  const sampled = runs.map((r) => r.sampledMb).filter((mb): mb is number => mb !== undefined)
  const foreign = runs.map((r) => r.foreignMb).filter((mb): mb is number => mb !== undefined)
  const workingSets = runs.map((r) => r.workingSetMb).filter((mb): mb is number => mb !== undefined)
  // Maxed, like every other peak here: the worst the BOX reached while any shard of this unit ran.
  const hostCommits = runs.map((r) => r.hostCommitPct).filter((p): p is number => p !== undefined)
  // Summed, not maxed: each shard is a separate window, so its `ownTicks` are separate samples of the
  // same unit. `treeMb` is maxed for the opposite reason — a peak is not additive across windows.
  const ownTicks = runs.reduce((a, r) => a + (r.ownTicks ?? 0), 0)
  const ticks = runs.reduce((a, r) => a + (r.ticks ?? 0), 0)
  // A discard remains the strongest fact. Otherwise fewer than three owning ticks can establish only
  // a lower bound, so withhold it even when a child happened to land in one or two heartbeats.
  const peakStatus: PeakStatus = PeakSeries.classifyPeak(
    ownTicks,
    peaks.length > 0,
    runs.some((r) => r.peakStatus === "discarded"),
    // 🔴 Read AFTER the unit finished, and it must be: overlap is a fact about the whole window, and
    // a unit admitted alone can have three neighbours join it two seconds later. Asking at admission
    // time would answer for the instant of the question rather than for the measurement.
    overlapped(),
    // 🔴 A split run's windows carry the previous shard's unreclaimed memory, so its reading is not
    // this unit's demand — see `PeakSeries.PeakStatus`. Declaring it here is what keeps the number
    // out of `peakMb` below, and therefore out of the ratchet and out of anybody's `peaks` entry.
    sharded,
  )

  // Only a bun test run has a skip count or a parseable failure list. Reading tsgo's output with either
  // parser would invent numbers, so a typecheck unit reports neither and both ledgers below ignore it.
  results.push({
    name,
    kind,
    order: job.order,
    ok: runs.every((r) => r.ok),
    ms: runs.reduce((a, r) => a + r.ms, 0),
    note: runs
      .map((r) => r.note)
      .filter(Boolean)
      .join(" · "),
    skipped,
    testCount,
    failing: kind === "test" ? [...new Set(runs.flatMap((r) => readFailingNames(r.captured)))] : [],
    ...(peakStatus === "measured" && peaks.length ? { peakMb: Math.max(...peaks) } : {}),
    ...(kind === "test" ? { peakStatus, ownTicks, ticks } : {}),
    ...(sampled.length ? { sampledMb: Math.max(...sampled) } : {}),
    ...(workingSets.length ? { workingSetMb: Math.max(...workingSets) } : {}),
    ...(foreign.length ? { foreignMb: Math.max(...foreign) } : {}),
    ...(hostCommits.length ? { hostCommitPct: Math.max(...hostCommits) } : {}),
    ...(sharded ? { shards: sharded } : {}),
  })
}

// novaclaw's integration tests must run isolated (see header). Enumerate its test/ subdirs that hold
// test files, plus the handful of top-level test files, and run each as its own process. Subdirs
// already promoted to fast-tier run units are skipped so `--full` never runs them twice.
/**
 * Files that genuinely cannot share a process — and the ONLY reason anything here is isolated.
 *
 * 🔴 They assert on PROCESS-GLOBAL state, so they pass alone and fail together, which is a different
 * defect from the hang this file used to isolate for:
 *
 *   - `lazy-command` asserts a module is loaded ONCE and shared between builder and handler, which is
 *     a claim about bun's module cache. Any earlier suite that imported it has already decided the
 *     answer.
 *   - `mcp/config-reload` (B7 tier-3) asserts a reconcile keeps the SAME client object. A connection
 *     another suite established is a different object.
 *
 * ⚠️ Add to this list only with a measurement: run the file alone and with the bulk, and show that it
 * passes alone and fails together. An entry added on suspicion costs a process every release gate
 * forever, which is exactly the bill this list replaced.
 */
const promotedSubdirs = new Set<string>(PROMOTED_NOVACLAW_SUBDIRS)
const promotedTestFiles = new Set<string>(PROMOTED_NOVACLAW_TEST_FILES)

/**
 * ─── phase 1: does the tree COMPILE ────────────────────────────────────────────────────────────────
 *
 * FIRST, and one package at a time.
 *
 * *First*, because a type error is the cheapest failure this suite can find and the most common one
 * after an edit. The whole phase measured **~52 s green** on 2026-07-28 against a run that takes
 * 312–478 s — so running it up front turns "the tree does not compile" from a six-minute answer into a
 * ten-second one (units run alphabetically with the heavyweight last; see lib/typecheck-units.ts).
 *
 * It earned that within ninety seconds of being wired up: the first real run came back
 * `15/19 typechecks green` on an uncommitted `TS7022` in `packages/core/src/host-exec.ts` — a dropped
 * type annotation that makes an inference cycle. Bun type-strips it away, so every test still passed.
 *
 * *One at a time*, because `tsgo --noEmit` on `packages/novaclaw` peaks **~3.8 GB for ~21 s** on a
 * 15.7 GB box, and GOMAXPROCS tuning measured WORSE, not better (4.55 GB — AGENTS.md pitfall #1). Two
 * of these at once, or one alongside a suite, is the documented path to a false wall-clock kill and to
 * pagefile thrashing that is written to the SSD. The root `bun run typecheck` delegates back to this
 * sequential phase; do not restore Turbo's parallel fan-out there.
 *
 * ⚠️ These units make `tsgo` visible to heavy-guard's HEAVY_PATTERNS, so a CONCURRENT `bun run test` or
 * desktop prebuild will now refuse while this phase is running. That is the guard working — but note it
 * cannot refuse THIS process: `enforce()` runs once, at import, before any of this.
 */
const REPO_ROOT = join(import.meta.dir, "..")
const WALL_START = Date.now()

/**
 * Start one unit ALONE: the full preflight, the rung, the header. Phase 1 is nothing but this.
 *
 * ⚠️ The preflight is the one the serial runner ran between every unit — a passed test can still
 * leak a child or retain several GB, and letting the next unit start on top of that is the cascading
 * false-failure shape of 2026-07-27. It also catches a local model or build started mid-run.
 */
async function runSolo(job: Job) {
  enforceTestMemory(`${job.kind} unit ${job.name}`)
  await waitForCommitFloor(job.name, job.kind)
  const plan = planSolo(job.name, job.kind, headroomOrRefuse(job.name, job.kind))
  const sharded = plan.mode === "sharded" && job.kind === "test" ? plan.shards : undefined
  process.stdout.write(
    `\n\x1b[1m▶ ${job.name}\x1b[0m${sharded ? `  \x1b[33m(low memory: split into ${sharded} shards — DEGRADED)\x1b[0m` : ""}\n`,
  )
  await run(job, sharded, () => false)
}

let jobIndex = 0
const nextJob = (name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number): Job => ({
  name,
  kind,
  dir,
  argv,
  wallclockMs,
  order: jobIndex++,
})

for (const unit of typecheckUnits(REPO_ROOT)) {
  if (ONLY && !unit.name.includes(ONLY)) continue
  await runSolo(nextJob(unit.name, "typecheck", unit.dir, ["run", "typecheck"], PACKAGE_WALLCLOCK_MS))
}

/**
 * ─── phase 2: do the tests pass ────────────────────────────────────────────────────────────────
 *
 * A POOL, not a loop. The scheduler, the budget it hands out and the order it hands it out in are
 * `lib/run-schedule.ts`; what follows is the plumbing that turns that into processes.
 */
const testJobs: Job[] = []
for (const pkg of PACKAGES) {
  if (pkg.fullOnly && !FULL) continue
  if (ONLY && !pkg.name.includes(ONLY)) continue
  const wallclock = pkg.wallclockMs ?? PACKAGE_WALLCLOCK_MS
  const perTest = pkg.timeoutMs ?? PER_TEST_TIMEOUT_MS
  const argv = (args: string[]) => ["test", ...args, `--timeout=${perTest}`]
  if (pkg.perSubdir)
    for (const sub of novaclawSubUnits(pkg.dir, promotedSubdirs, promotedTestFiles))
      testJobs.push(
        nextJob(
          `${pkg.name} ${sub.unit}`,
          "test",
          pkg.dir,
          argv(sub.args),
          pkg.subdirWallclockMs?.[sub.unit] ?? wallclock,
        ),
      )
  else testJobs.push(nextJob(pkg.name, "test", pkg.dir, argv(pkg.args), wallclock))
}

const CONCURRENCY = RunSchedule.concurrencyCap(os.cpus().length, process.env.NOVACLAW_TEST_CONCURRENCY)
/** History for the longest-first order. A missing series is "no history", never a fault. */
const seriesHistory = (() => {
  try {
    return readFileSync(PeakSeries.seriesPath(REPO_ROOT), "utf8")
  } catch {
    return ""
  }
})()
const queue = RunSchedule.orderByCost(testJobs, (job) => job.name, RunSchedule.observedCosts(seriesHistory))

/** A unit currently running, and the budget it holds until it stops. */
type Live = {
  readonly job: Job
  readonly reservation: RunSchedule.Reservation
  /** Set the moment a second unit is in flight beside it — see `PeakSeries.PeakStatus`. */
  overlapped: boolean
  /** Resolves when the unit's result has been recorded and it has left the pool. */
  settled: Promise<void>
}
const inFlight = new Map<string, Live>()
/** The idle measurement every reservation is handed out of. Re-taken whenever the pool empties. */
let budget: MemoryHeadroom | undefined
let peakConcurrency = 0

/** Everyone in flight has now seen a neighbour, and so has whoever just joined them. */
function markOverlap() {
  peakConcurrency = Math.max(peakConcurrency, inFlight.size)
  if (inFlight.size < 2) return
  for (const live of inFlight.values()) live.overlapped = true
}

/** What one unit promises to hold for its whole life, in both currencies. */
const reservationFor = (job: Job): RunSchedule.Reservation => {
  const demand = demandOf(job.name, job.kind)
  return {
    unit: job.name,
    commitBytes: MemoryPlan.reservedBytes(demand.commitPeakMb),
    residentBytes: MemoryPlan.reservedBytes(demand.residentPeakMb),
    // ⚠️ BOTH walls, and read from the profile rather than from the demand: `demandOf` has already
    // substituted `UNPROFILED_*_MB` for whatever was missing, so by then the guess is indistinguish-
    // able from a measurement. This is the last place the difference is still visible.
    profiled: peakProfiles.commit[job.name] !== undefined && peakProfiles.resident[job.name] !== undefined,
  }
}

function start(job: Job, reservation: RunSchedule.Reservation, sharded: number | undefined) {
  const live: Live = { job, reservation, overlapped: false, settled: Promise.resolve() }
  // `settled` is assigned after the record exists so the callback below closes over `live` and reads
  // `overlapped` at the END of the unit rather than capturing whatever it was at admission.
  live.settled = run(job, sharded, () => live.overlapped)
    .catch((error: unknown) => {
      // A throw here is a bug in the runner, not a test failure, and it must not vanish into an
      // unhandled rejection while the pool carries on reporting green.
      process.stderr.write(`\n\x1b[31m${job.name}: the runner itself threw — ${String(error)}\x1b[0m\n`)
      results.push({
        name: job.name,
        kind: job.kind,
        order: job.order,
        ok: false,
        ms: 0,
        note: `the runner threw: ${String(error)}`,
        skipped: undefined,
        testCount: undefined,
        failing: [],
      })
    })
    .finally(() => {
      inFlight.delete(job.name)
    })
  inFlight.set(job.name, live)
  markOverlap()
  process.stdout.write(
    `\n\x1b[1m▶ ${job.name}\x1b[0m` +
      (sharded ? `  \x1b[33m(low memory: split into ${sharded} shards — DEGRADED)\x1b[0m` : "") +
      `  \x1b[2m(${inFlight.size} in flight)\x1b[0m\n`,
  )
}

/**
 * Admit the head of the queue, or explain why not.
 *
 * ⚠️ The order of the checks is the point: the CHEAP and PURE ones first, the two that spawn
 * PowerShell last. `hostCommitPct()` and heavy-guard's `Win32_Process` scan cost hundreds of
 * milliseconds each and this runs on every completion, so asking them before the arithmetic has
 * agreed would spend a large slice of the time this whole change is meant to save.
 */
async function admitNext(): Promise<boolean> {
  const job = queue[0]
  if (job === undefined) return false

  if (inFlight.size === 0) {
    // The serial path, unchanged in substance: a live reading of a machine holding none of our work
    // IS the idle budget, so the arithmetic below is identical to the old `planUnit`.
    queue.shift()
    enforceTestMemory(`${job.kind} unit ${job.name}`)
    await waitForCommitFloor(job.name, job.kind)
    const headroom = headroomOrRefuse(job.name, job.kind)
    // The pool's budget is the idle headroom LESS the harness's own fixed slack, charged once — see
    // `MemoryPlan.reservedBytes`. `planSolo` below still uses the full `requiredBytes`, because it
    // is answering the other question: does this one unit fit on this machine at all.
    budget = RunSchedule.poolBudget(headroom, MemoryPlan.SLACK_BYTES)
    const plan = planSolo(job.name, job.kind, headroom)
    start(job, reservationFor(job), plan.mode === "sharded" ? plan.shards : undefined)
    return true
  }

  if (budget === undefined) return false
  const candidate = reservationFor(job)
  const verdict = RunSchedule.admits(
    budget,
    [...inFlight.values()].map((live) => live.reservation),
    candidate,
    CONCURRENCY,
  )
  if (!verdict.admit) return false

  // The live brake, and the ONE reading that still has to be taken beside our own work: the budget
  // accounts for what WE promised, and nothing at all for a neighbour that appeared since it was
  // measured. 90% is the product's floor and has never been observed on this box (0 of 348 rows).
  const pct = readCommitPct()
  if (pct !== undefined && pct >= COMMIT_FLOOR_PCT) {
    process.stdout.write(
      `  \x1b[33mhost commit ${pct}% is at or above the ${COMMIT_FLOOR_PCT}% FLOOR — holding ${job.name} ` +
        `until a unit finishes\x1b[0m\n`,
    )
    return false
  }
  // Foreign-job arm only: our own pool is holding this machine down on purpose. See `ownWorkInFlight`.
  enforceTestMemory(`${job.kind} unit ${job.name}`, true)

  queue.shift()
  // ⚠️ Never SHARDED from here. The sharded rung is a memory mitigation whose own peak reads high,
  // and a unit that does not fit beside its neighbours has a better option than degrading: wait for
  // one of them to finish and run whole. Sharding stays for the machine that cannot fit it ALONE.
  start(job, candidate, undefined)
  return true
}

if (queue.length > 0) {
  process.stdout.write(
    `\n\x1b[1m── phase 2: ${queue.length} test unit(s), up to ${CONCURRENCY} at a time ──\x1b[0m\n` +
      // ⚠️ PRINTED, because the order is derived from a gitignored log and therefore varies by
      // machine and by history. An order nobody can see is an order nobody can reproduce a
      // load-dependent red against.
      `  \x1b[2mlongest-first from tmp/peak-series.jsonl: ${queue.map((job) => job.name).join(", ")}\x1b[0m\n`,
  )
}

while (queue.length > 0 || inFlight.size > 0) {
  while (await admitNext()) {
    /* keep admitting while there is room */
  }
  if (inFlight.size === 0) {
    // Unreachable: `admits` always admits into an empty pool, so an empty pool with a non-empty
    // queue means the very first check refused. Say so rather than spinning forever — a scheduler
    // that live-locks looks exactly like a hang, which is the one failure this file may not have.
    abort(2, `\n\x1b[31mthe scheduler admitted nothing and holds nothing — ${queue.length} left\x1b[0m\n`)
  }
  await Promise.race([...inFlight.values()].map((live) => live.settled))
}

sampler.stop()

// The host may not be left unsafe by a green run, or the suite normalizes a leak as an acceptable
// side effect. Once, at the end: the per-unit version of this check is `admitNext`'s preflight.
enforceTestMemory("the host after the suite")

const WALL_MS = Date.now() - WALL_START
const totalMs = results.reduce((a, r) => a + r.ms, 0)
results.sort((a, b) => a.order - b.order)

/**
 * The committed ledger, read once. `units` = skip counts; `failing` = failures pinned by name.
 *
 * A MISSING baseline is the seeding state. A malformed one is a FAULT and must say so — swallowing the
 * parse error would silently disarm both ledgers, which is the exact "reads as coverage while being
 * none" failure this whole file exists to remove (todo.md ruling 2: a fault is never described falsely).
 */
type Baseline = {
  note?: string
  reasons?: Record<string, string>
  units?: Record<string, number>
  counts?: Record<string, number>
  failing?: Record<string, string[]>
  /** Measured peak MB per run unit — the input to the memory ladder. See `readPeaks` above. */
  peaks?: Record<string, number>
}
const BASELINE_PATH = join(import.meta.dir, "test-baseline.json")

function readBaseline(): {
  units: Record<string, number>
  counts: Record<string, number>
  failing: Record<string, string[]>
  seeded: boolean
  broken?: string
} {
  let raw: string
  try {
    raw = readFileSync(BASELINE_PATH, "utf8")
  } catch {
    return { units: {}, counts: {}, failing: {}, seeded: false }
  }
  try {
    const parsed = JSON.parse(raw) as Baseline
    const units = parsed.units ?? {}
    const counts = parsed.counts ?? {}
    return { units, counts, failing: parsed.failing ?? {}, seeded: Object.keys(units).length > 0 }
  } catch (error) {
    return {
      units: {},
      counts: {},
      failing: {},
      seeded: false,
      broken: error instanceof Error ? error.message : String(error),
    }
  }
}

const baseline = readBaseline()

/**
 * ─── the EXPECTED-FAILURE ledger ───────────────────────────────────────────────────────────────────
 * Promoting the HTTP/contract suites out of `--full` (Wave 0) did what it was meant to do: two of the
 * four open RED on Windows-from-source. Leaving them merely red would make the headline number
 * permanently 19/21, and a suite that is never green is a suite nobody reads — the same "reads as
 * coverage while being none" failure from the other direction.
 *
 * So the failures are PINNED BY NAME. A unit whose failing set exactly matches its baseline reports
 * PINN rather than FAIL; any NEW failure, or a pinned one that now PASSES, fails the run and says
 * which. That makes the set a ratchet that can only shrink — the opposite of `--full` as a parking
 * lot, because every pinned name sits in a committed file and shows up in review.
 *
 * ⚠️ Pinning is for failures that are UNDERSTOOD AND FILED, never for "make it green". Each unit's
 * reason belongs in the baseline's `reasons` map.
 */
const expectedFailures = new Map(Object.entries(baseline.failing).map(([unit, names]) => [unit, [...names].sort()]))
// ⚠️ Was a local `sameSet` that compared ORDER, not membership — see script/lib/ledger-drift.ts for
// what that cost. Never inline this back: the header below is printed FROM the diffs, so the two can
// no longer disagree.
const ledgerMatches = (pinned: string[], failing: string[]) => LedgerDrift.clean(LedgerDrift.compute(pinned, failing))

const pinnedOk: Result[] = []
const failed: Result[] = []
for (const r of results) {
  if (r.ok) continue
  const pinned = expectedFailures.get(r.name)
  // Only an assertion-level failure can be pinned. A wall-clock kill or a spawn error produces no
  // parseable list, and pinning "the unit died" would hide exactly the thing worth seeing.
  if (pinned && r.failing.length > 0 && ledgerMatches(pinned, r.failing)) pinnedOk.push(r)
  else failed.push(r)
}
const isPinned = (r: Result) => pinnedOk.includes(r)

process.stdout.write(`\n\x1b[1m── summary ──\x1b[0m\n`)
for (const r of results) {
  // A sharded PASS is not a plain PASS and must never print as one — the composition it exercised is
  // not the composition the gate is defined over. `PASS*` plus the note is the whole honesty budget.
  const tag = r.ok
    ? r.shards
      ? "\x1b[33mPASS*\x1b[0m"
      : "\x1b[32mPASS\x1b[0m"
    : isPinned(r)
      ? "\x1b[33mPINN\x1b[0m"
      : "\x1b[31mFAIL\x1b[0m"
  const degraded = r.shards ? `sharded ×${r.shards} (DEGRADED — composition differs from a whole run)` : ""
  const failures = r.failing.length ? `failing: ${r.failing.join("; ")}` : ""
  const note = isPinned(r)
    ? `${r.failing.length} pinned failure(s) — see ${BASELINE_PATH}`
    : [failures, r.note].filter(Boolean).join(" · ")
  process.stdout.write(
    `  ${tag}${r.shards ? "" : " "} ${r.name.padEnd(30)} ${(r.ms / 1000).toFixed(1)}s  ${[degraded, note].filter(Boolean).join("  ·  ")}\n`,
  )
}

/**
 * ─── the PEAK profile ──────────────────────────────────────────────────────────────────────────────
 * What each unit actually cost, so the next run can PLAN instead of guessing. Before this the harness
 * knew one number — a flat 6 GB floor derived from an incident — and it was ~6× the measured need of
 * the heaviest unit, which is why the gate was unrunnable on an ordinary desktop.
 *
 * ⚠️ REPORTED, not enforced. This suite's wall clock swings 24 % on a byte-identical tree
 * (todo/test-speed.md) and memory swings with it, so a ratchet armed on the first observation would
 * fire on noise and be deleted within a week. Arming it wants a few runs of data — the numbers below
 * are how that data gets collected.
 */
const measured = results.filter((r) => r.peakMb !== undefined)
if (measured.length) {
  process.stdout.write(`\n\x1b[1m── peak memory (MB) ──\x1b[0m\n`)
  // 🔴 State what these numbers ARE, in the place they are read. Until 2026-08-07 every row here also
  // contained the runner's `bun run test` parent shim — a constant 41–45 MB — and for a sub-second
  // unit the shim was the ONLY thing in it (`schema` 43, `effect-drizzle-sqlite` 45, with a `ratio`
  // derived from them). Nothing printed said so, which is how a fabrication passed for a measurement.
  const excluded = Math.max(0, ...results.map((r) => r.foreignMb ?? 0))
  process.stdout.write(
    `  \x1b[2mown processes only — every \`bun\` born before a unit started is excluded from it` +
      `${excluded > 0 ? ` (peak excluded this run: ${excluded} MB, normally the \`bun run test\` shim)` : ""}\x1b[0m\n`,
  )
  for (const r of measured) {
    const was = peakProfiles.commit[r.name]
    // 🔴 A SHARDED run's peak is recorded, and it MEASURES HIGH — the note here used to say it
    // "measures close to the whole", and the series says otherwise. For `core`: 18 whole runs have a
    // median of 10,235 MB and a max of 10,822, while 168 sharded runs have a median of 12,936 and a
    // max of 17,833. Shards run SEQUENTIALLY, so the excess is not two processes at once; it is the
    // previous shard's memory not yet reclaimed inside the next shard's window.
    //
    // ⚠️ That closes a LOOP which would otherwise make `core` permanently DEGRADED: an inflated peak
    // enters the profile, the planner reads it and decides the unit cannot fit whole, so it shards,
    // so the next measurement is inflated again. Recording a sharded peak is still what closes the
    // bootstrap for an unprofiled unit — but such a reading must never be promoted as if it were the
    // unit's own demand.
    //
    // 🔴 **The loop is CLOSED, and this note used to say otherwise.** It read *"`core`'s profile says
    // 17,958 MB against a whole-run maximum of 10,822"*, describing a live defect. The profile now
    // says **10,822** — the whole-run maximum exactly — so the promotion rule has been applied and
    // the planner budgets `core` against real demand. Re-measured from `tmp/peak-series.jsonl`
    // (2026-08-15, 257 `core` rows): 25 WHOLE runs median 10,198 / max 10,822; 232 SPLIT runs median
    // 10,117 / max 17,833, with 88 of them above the profile. The inflation is real, which is why
    // the rule stays; the loop it once caused is not.
    //
    // 🔴 **And the rule is MECHANICAL now, which is why no sharded row reaches this block at all.**
    // A split run classifies as `sharded` (`PeakSeries.PeakStatus`), so it carries no `peakMb` and
    // prints under "peak NOT recorded" with its raw reading instead. This block is therefore the
    // whole-run block, and the number in it is always promotable. The paragraphs above are kept as
    // the WHY — the profile figure is still the only thing holding the sharding loop shut, and a
    // reader who does not know the split reading is inflated will paste one in from elsewhere.
    // ⚠️ A peak taken from one or two samples is a LOWER BOUND, and saying so is the cheap half of
    // the fix that item 4 of todo/test-speed.md makes structural. A 300 ms unit gets 2–4 ticks at a
    // 200 ms interval and its child may be visible in none of them.
    const bound = r.ownTicks !== undefined && r.ownTicks > 0 && r.ownTicks < 3
    const drift =
      was === undefined
        ? // 🔴 This branch used to read "copy it into test-baseline.json's peaks" UNCONDITIONALLY,
          // which told the reader to do the precise thing the 2026-08-07 re-baseline forbids: two
          // units are absent from the profile ON PURPOSE because every reading of them is a lower
          // bound, and pasting one in would put a guess into the ladder wearing a measurement's
          // clothes. An instruction that contradicts the file it points at is worse than none.
          // ⚠️ …and `deliberatelyAbsent` closes the OTHER half of the same hole. `bound` only knows
          // about THIS run: a unit that happens to get 3+ ticks today stops looking like a bound and
          // the line flips back to "copy it in" — which is how `script` came to be advertised at
          // 345 MB while the series holds an observation of 625. Three samples is enough to stop
          // being obviously thin, not enough to have seen the peak. Which units that applies to is a
          // property of the SERIES, so it is recorded in the baseline rather than re-derived here.
          bound || peakProfiles.deliberatelyAbsent.has(r.name)
          ? '  \x1b[2m(absent from "peaks" — do NOT paste a bound in; see peaksUnsampledNote)\x1b[0m'
          : '  (not in profile — copy it into test-baseline.json\'s "peaks")'
        : MemoryPlan.peakRegressed(was, r.peakMb ?? 0)
          ? `  \x1b[33m<- profile says ${was}; that is a real jump, look at it\x1b[0m`
          : ""
    const thin = bound
      ? `  \x1b[2m(${r.ownTicks} sample${r.ownTicks === 1 ? "" : "s"} — a lower bound, not a peak)\x1b[0m`
      : ""
    const resident = r.workingSetMb === undefined ? "" : `  resident ${r.workingSetMb} MB`
    process.stdout.write(`  ${r.name.padEnd(30)} ${String(r.peakMb).padStart(5)}${resident}${drift}${thin}\n`)
  }
}

/**
 * ─── the units with NO peak, and WHICH kind of no ──────────────────────────────────────────────────
 *
 * 🔴 The block above prints only what it measured, so a unit that produced no number simply vanished
 * from it — and `core`, the unit the whole profile exists to watch, vanished from three consecutive
 * gates while its sampler was working perfectly. A discard is a MEASUREMENT above a ceiling; it is
 * strictly more information than a green row, and printing nothing was ruling 2 at the reporting
 * layer (a fault described falsely — as an absence).
 */
const unmeasured = results.filter((r) => r.kind === "test" && (r.peakStatus ?? "unsampled") !== "measured")
if (unmeasured.length) {
  process.stdout.write(`\n\x1b[1m── peak NOT recorded ──\x1b[0m\n`)
  for (const r of unmeasured)
    process.stdout.write(
      // 🔴 The FOURTH null, and the one that is a DESIGN DECISION rather than an instrument problem.
      // Attribution is by process birth time, so a neighbour's `bun` lands inside this unit's window
      // too and the reading is the pool's. Withholding it is what keeps a neighbour's memory out of
      // `test-baseline.json`'s `peaks`, which is the input to the sharding ladder.
      r.peakStatus === "concurrent"
        ? `  ${r.name.padEnd(30)} \x1b[33mCONCURRENT\x1b[0m  ${r.sampledMb ?? "?"} MB sampled across the POOL, not this unit —\n` +
            `  ${" ".repeat(30)} another run unit was in flight, and birth-time attribution cannot separate\n` +
            `  ${" ".repeat(30)} them. Re-measure a unit with \`--only=${r.name.split(" ")[0]}\` or\n` +
            `  ${" ".repeat(30)} NOVACLAW_TEST_CONCURRENCY=1 before touching its "peaks" entry.\n`
        : // 🔴 The FIFTH null, and the one that used to be recorded as a measurement — which put it in
          // front of the armed peak ratchet and could fail a memory-poor gate on its own mitigation.
          // Shards run sequentially, so each window carries the previous shard's unreclaimed memory:
          // `core` reads a median 10,117 / max 17,833 MB split against a 10,822 whole-run maximum.
          r.peakStatus === "sharded"
          ? `  ${r.name.padEnd(30)} \x1b[33mSHARDED\x1b[0m  ${r.sampledMb ?? "?"} MB sampled across ${r.shards} sequential shards,\n` +
            `  ${" ".repeat(30)} which reads HIGH — the previous shard's memory is not yet reclaimed inside\n` +
            `  ${" ".repeat(30)} the next shard's window. The peak is withheld, so it can neither fail the\n` +
            `  ${" ".repeat(30)} ratchet nor be promoted into "peaks". Re-measure whole on a quiet box.\n`
          : r.peakStatus === "discarded"
            ? `  ${r.name.padEnd(30)} \x1b[33mDISCARDED\x1b[0m  sampled ${r.sampledMb} MB, over the ` +
              `${IMPLAUSIBLE_PEAK_MB} MB ceiling` +
              `${peakProfiles.commit[r.name] === undefined ? "" : ` (profile ${peakProfiles.commit[r.name]})`}\n` +
              `  ${" ".repeat(30)} the sampler WORKED — this is a reading, not an absence, and it is now\n` +
              `  ${" ".repeat(30)} attributed: only processes this unit itself created are in it.\n`
            : // ⚠️ `unsampled` is itself two different facts, not one, and attribution added the second:
              // "the unit owned no tick" is the benign case that used to be reported as a 43 MB
              // measurement, so it must not now be reported as an instrument failure either. Say which.
              (r.ownTicks ?? 0) > 0
              ? `  ${r.name.padEnd(30)} \x1b[33mUNSAMPLED\x1b[0m  sampled ${r.sampledMb} MB across ${r.ownTicks} owning tick(s);\n` +
                `  ${" ".repeat(30)} fewer than ${PeakSeries.MIN_RECORDED_OWN_TICKS} observations is a lower bound, not a peak, so the number was withheld.\n`
              : (r.ticks ?? 0) > 0
                ? `  ${r.name.padEnd(30)} \x1b[33mUNSAMPLED\x1b[0m  ${r.ticks} tick(s) landed here and this unit owned\n` +
                  `  ${" ".repeat(30)} none of them — its process fit between two 200 ms heartbeats. The\n` +
                  `  ${" ".repeat(30)} instrument is fine; the unit is too short to measure this way.\n`
                : `  ${r.name.padEnd(30)} \x1b[33mUNSAMPLED\x1b[0m  no timeline row landed in this unit's window at all\n`,
    )
}

/**
 * ─── the peak SERIES ───────────────────────────────────────────────────────────────────────────────
 * The block above is per-run and ephemeral, so *"does gate degradation accumulate across consecutive
 * runs?"* has never had more than one point to answer it with. Append the same numbers, one row per
 * test unit per run, and it becomes a series. `lib/peak-series.ts` holds the row shape and its check.
 *
 * ⚠️ **It cannot fail the run, and that is deliberate.** `append` returns its failure as a value; a
 * full disk or a locked file prints a warning and the exit code below never sees it. An instrument
 * that can take down the thing it measures is worse than no instrument.
 *
 * ⚠️ **`tmp/` (gitignored), never a tracked artifact.** The gate observes the profile here; it does
 * NOT write `test-baseline.json`, which stays hand-maintained — a baseline that ratchets to whatever
 * the machine last did is not a baseline.
 */
const seriesRows = PeakSeries.buildRows(RUN_STAMP, PeakSeries.scopeLabel(FULL, ONLY), results, peakProfiles.commit)
const series = PeakSeries.append(PeakSeries.seriesPath(REPO_ROOT), seriesRows)
// Self-describing, because the block header above only prints when something was MEASURED while a row
// is appended for every test unit that ran — the two can legitimately disagree.
if (series.ok && series.rows > 0)
  process.stdout.write(`  peak series  +${series.rows} row(s) -> ${series.path}  (run ${RUN_STAMP})\n`)
else if (!series.ok)
  process.stdout.write(
    `  \x1b[33mpeak series NOT appended\x1b[0m (${series.path}): ${series.reason}\n` +
      `  The gate is unaffected — this is a log, and a log may never decide a run.\n`,
  )

/**
 * ─── the peak ratchet, ARMED (2026-08-12) ──────────────────────────────────────────────────────
 *
 * `regressed` was computed, written to the series, and NEVER read here — so a real regression
 * changed nothing about the run. It now fails, with the withholding branch the evidence supports
 * (`PeakSeries.regressionVerdict`): the older 1616-row audit's 4 fires included two measured beside
 * up to 6.8 GB of foreign memory, which is attribution under host load rather than a regression.
 *
 * ⚠️ The message carries `hostCommitPct`, `foreignMb` and `ownTicks` deliberately. ZERO regressed rows
 * have been recorded since those fields existed (316 rows, 26 gates), so the first time this fires is
 * also the first sample of the thing the analysis needs — and a message that omitted them would force
 * a re-run to collect data the failing run already had in hand.
 */
const peakVerdicts = seriesRows
  .map((row) => ({ row, ...PeakSeries.regressionVerdict(row) }))
  .filter((entry) => entry.verdict !== "clean")
const peakRegressions = peakVerdicts.filter((entry) => entry.verdict === "regressed")
if (peakVerdicts.length) {
  process.stdout.write(`\n\x1b[1m── peak ratchet ──\x1b[0m\n`)
  for (const { row, verdict, reason } of peakVerdicts)
    process.stdout.write(
      verdict === "withheld"
        ? `  ${row.unit.padEnd(24)} \x1b[33mWITHHELD\x1b[0m  ${row.peakMb} MB vs profile ${row.profileMb} MB — ${reason},\n` +
            `  ${" ".repeat(24)} so this reads as the machine rather than the unit. Re-run quiet to judge it.\n`
        : `  ${row.unit.padEnd(24)} \x1b[31mREGRESSED\x1b[0m  ${row.peakMb} MB vs profile ${row.profileMb} MB (ratio ${row.ratio})\n` +
            `  ${" ".repeat(24)} host commit ${row.hostCommitPct ?? "?"}%, foreign ${row.foreignMb ?? "?"} MB, ${row.ownTicks ?? "?"} owning tick(s) — a CLEAN sample.\n` +
            `  ${" ".repeat(24)} Either the unit really got heavier, or its profile entry is stale.\n`,
    )
}

/**
 * ─── the SKIPPED ledger ────────────────────────────────────────────────────────────────────────────
 * A skipped test is coverage the suite claims and does not have, and nothing used to say how much
 * of it there was. The ledger is asserted against a COMMITTED baseline, so adding a skip (a new
 * `describe.skipIf`, a platform gate) is a visible diff in review rather than a silent hole. Only
 * units that actually RAN are compared, so `--only=` and `--full` stay usable.
 *
 * ⚠️ **It counts what bun prints as `skip`, and nothing else.** The scan is a `\d+ skip` match
 * over each unit's own summary line, so a `todo` line is NOT in this number — `it.todo` is a hole
 * this ledger cannot see. Widen the pattern before claiming otherwise.
 *
 * Seeding: the baseline ships with an empty `units` and `counts` map because the values can only be
 * learned by running the suite. While either map is empty its ledger prints what it observed, says so,
 * and does NOT affect the exit code. Paste the observed numbers into script/test-baseline.json and
 * commit them; from then on a change to any count fails the run.
 */
// Typecheck units produce no bun summary and never could: including them here would print a row of
// "no bun summary — crashed or killed" for every package on every GREEN run, which is this file
// describing a fault falsely (todo.md ruling 2) rather than reporting one.
const testResults = results.filter((r) => r.kind === "test")
const observed = testResults.filter((r) => r.skipped !== undefined)
const unreadable = testResults.filter((r) => r.skipped === undefined)
const totalSkipped = observed.reduce((a, r) => a + (r.skipped ?? 0), 0)

process.stdout.write(`\n\x1b[1m── skipped ──\x1b[0m\n`)
if (testResults.length && !observed.length) {
  // Every unit unreadable is not N crashes — it means bun's summary is no longer on the stream we
  // capture (it writes the reporter to stderr today). Say that once instead of N times.
  //
  // ⚠️ …but only when the units PASSED. "Every unit unreadable" is trivially true when there is one
  // unit (`--only=core`), and a unit that was wall-clock-killed is unreadable for the obvious reason.
  // Measured 2026-08-05: this printed the reporter-moved hypothesis for a killed `core`, and the
  // hypothesis is what a reader acts on — it cost two 300 s runs spent looking at readSkipCount()
  // while the answer ("WALL-CLOCK KILL at 300s") was already in the row above. The script knows which
  // units failed; offering a diagnosis it can rule out is ruling 2 at the reporting layer.
  const broken = testResults.filter((r) => !r.ok)
  process.stdout.write(
    broken.length > 0
      ? `  \x1b[33mNO RUN UNIT PRODUCED A READABLE BUN SUMMARY\x1b[0m — the ledger could not be built.\n` +
          `  ${broken.length} of ${testResults.length} unit(s) did not finish (${broken
            .map((r) => `${r.name}: ${r.note || "failed"}`)
            .join("; ")}) — that is the cause; the ledger is a symptom.\n`
      : `  \x1b[33mNO RUN UNIT PRODUCED A READABLE BUN SUMMARY\x1b[0m — the ledger could not be built.\n` +
          `  Every unit PASSED, so bun's reporter moved off stderr and readSkipCount() needs updating.\n`,
  )
} else if (!testResults.length) {
  process.stdout.write(`  (no test units ran — nothing to count)\n`)
} else {
  for (const unit of observed.filter((r) => (r.skipped ?? 0) > 0))
    process.stdout.write(`  ${unit.name.padEnd(30)} ${String(unit.skipped ?? 0).padStart(4)}\n`)
  process.stdout.write(`  ${"total".padEnd(30)} ${String(totalSkipped).padStart(4)}  (units not listed skipped 0)\n`)
  for (const r of unreadable)
    process.stdout.write(`  \x1b[33m${r.name.padEnd(30)}    ?  (no bun summary — crashed or killed)\x1b[0m\n`)
}

let skipDrift = false
if (baseline.broken) {
  // Not the seeding state — a corrupt ledger that would otherwise assert nothing while looking armed.
  skipDrift = true
  process.stdout.write(
    `\n  \x1b[31mBASELINE UNREADABLE\x1b[0m — script/test-baseline.json is not valid JSON: ${baseline.broken}\n`,
  )
} else if (!baseline.seeded) {
  process.stdout.write(
    `\n  \x1b[33mBASELINE NOT SEEDED\x1b[0m — script/test-baseline.json has no counts yet, so nothing was\n` +
      `  asserted and the exit code is unaffected. Copy the numbers above into its "units" map and commit\n` +
      `  them; after that, any change to a skip count fails the run.\n`,
  )
} else {
  // A unit with no baseline entry is treated as 0, so a NEW run unit that skips nothing stays silent
  // while one that skips something must be recorded before the suite goes green again. That asymmetry
  // is the point: an unrecorded skip is exactly the hole this ledger exists to surface.
  const drift = observed
    .map((r) => ({ name: r.name, was: baseline.units[r.name], now: r.skipped ?? 0 }))
    .filter((d) => (d.was ?? 0) !== d.now)
  if (drift.length) {
    skipDrift = true
    process.stdout.write(
      `\n  \x1b[31mSKIP COUNTS CHANGED\x1b[0m — update script/test-baseline.json in the same commit:\n`,
    )
    for (const d of drift)
      process.stdout.write(
        `    ${d.name.padEnd(30)} ${d.was === undefined ? "not in baseline" : `baseline ${d.was}`}  ->  observed ${d.now}\n`,
      )
  }
}

/**
 * ─── the TEST-COUNT ledger ────────────────────────────────────────────────────────────────────────
 * A test file can disappear while the remaining tests stay green. Bun's completed total is the cheap
 * mechanical signal for that class of hole, so keep it beside the skip ledger rather than trusting a
 * directory enumeration that does not prove execution. Shards contribute disjoint totals and are
 * summed in `run()` before this comparison.
 */
const observedCounts = testResults.filter((r) => r.testCount !== undefined)
const unreadableCounts = testResults.filter((r) => r.testCount === undefined)
const countBaselineSeeded = Object.keys(baseline.counts).length > 0
let testCountDrift = false
process.stdout.write(`\n\x1b[1m── test counts ──\x1b[0m\n`)
for (const r of testResults)
  process.stdout.write(`  ${r.name.padEnd(30)} ${r.testCount === undefined ? "?" : String(r.testCount).padStart(4)}\n`)
if (unreadableCounts.length)
  process.stdout.write(
    `  \x1b[33m${unreadableCounts.length} test unit(s) had no completed Bun count; their process output was incomplete.\x1b[0m\n`,
  )
if (!countBaselineSeeded) {
  process.stdout.write(
    `  \x1b[33mTEST-COUNT BASELINE NOT SEEDED\x1b[0m — copy the observed counts into the "counts" map in ${BASELINE_PATH};\n` +
      `  until then this new ratchet reports but does not affect the exit code.\n`,
  )
} else {
  const missing = observedCounts.filter((r) => baseline.counts[r.name] === undefined && (r.testCount ?? 0) > 0)
  const changed = observedCounts
    .filter((r) => baseline.counts[r.name] !== undefined)
    .filter((r) => baseline.counts[r.name] !== r.testCount)
  if (missing.length || changed.length || unreadableCounts.length) {
    testCountDrift = true
    process.stdout.write(`\n  \x1b[31mTEST COUNTS CHANGED OR UNREADABLE\x1b[0m — update the baseline only with an intentional test diff:\n`)
    for (const r of missing)
      process.stdout.write(`    ${r.name.padEnd(30)} not in baseline  ->  observed ${r.testCount}\n`)
    for (const r of changed)
      process.stdout.write(`    ${r.name.padEnd(30)} baseline ${baseline.counts[r.name]}  ->  observed ${r.testCount}\n`)
    for (const r of unreadableCounts)
      process.stdout.write(`    ${r.name.padEnd(30)} baseline ${baseline.counts[r.name] ?? "not recorded"}  ->  no completed count\n`)
  }
}

let ledgerDrift = false
for (const [unit, pinned] of expectedFailures) {
  const result = results.find((r) => r.name === unit)
  if (!result) continue // not run this invocation (--only=, or --full-gated): nothing to say
  const drift = LedgerDrift.compute(pinned, result.failing)
  if (LedgerDrift.clean(drift)) continue
  ledgerDrift = true
  process.stdout.write(`\n  \x1b[31mEXPECTED-FAILURE DRIFT · ${unit}\x1b[0m\n`)
  for (const name of drift.fresh) process.stdout.write(`    \x1b[31m+ NEW FAILURE\x1b[0m   ${name}\n`)
  for (const name of drift.fixed)
    process.stdout.write(`    \x1b[32m- now passing\x1b[0m   ${name}   (remove it from ${BASELINE_PATH})\n`)
  // A test reported failing more often than it is pinned. Not a ledger edit — look at the sharding.
  for (const name of drift.repeated)
    process.stdout.write(`    \x1b[33m! reported twice\x1b[0m ${name}   (a shard ran it more than once)\n`)
}
if (pinnedOk.length) {
  process.stdout.write(`\n\x1b[33m── pinned failures (expected, filed) ──\x1b[0m\n`)
  for (const r of pinnedOk) process.stdout.write(`  ${r.name.padEnd(30)} ${r.failing.length} known failure(s)\n`)
}

// The two kinds are counted SEPARATELY on the headline. Folding typechecks into the test count would
// silently redefine the number todo.md tracks ("21/21 run units green") without anything having changed
// about the tests, and the two answer different questions: does the tree compile, and do the tests pass.
const typecheckResults = results.filter((r) => r.kind === "typecheck")
const greenOf = (rows: Result[]) => rows.filter((r) => !failed.includes(r)).length
const tally = (label: string, rows: Result[]) =>
  rows.length
    ? `${greenOf(rows) === rows.length ? "\x1b[32m" : "\x1b[31m"}${greenOf(rows)}/${rows.length} ${label}\x1b[0m`
    : ""
// A `--only=` that matches nothing used to print `0/0 run units green` and exit 0 — a typo reported as
// success, which is the one thing this file may never do (todo.md ruling 2). Now it says so and fails.
const matchedNothing = results.length === 0
if (matchedNothing)
  process.stdout.write(
    `\n  \x1b[31mNO RUN UNIT MATCHED\x1b[0m ${ONLY === undefined ? "(nothing to run)" : `--only=${ONLY}`} — ` +
      `unit names are the ones printed by a full run, not directory paths.\n`,
  )
const shardedUnits = results.filter((r) => r.shards)
process.stdout.write(
  `\n${[tally("test units green", testResults), tally("typechecks green", typecheckResults)].filter(Boolean).join("  ·  ")}` +
    // 🔴 **`totalMs` was labelled "wall" and it never was.** It is the sum of the units' own times,
    // which equalled the wall clock only because the runner was serial — the very fact that made
    // this change worth doing (1080 s of unit time in 1142 s of wall clock). Now that they diverge
    // on purpose, printing the sum under the wall clock's name would be the gate reporting a number
    // that is not the thing it is called. Both, and the concurrency that explains the gap.
    `  ·  ${(WALL_MS / 1000).toFixed(1)}s wall` +
    `  ·  ${(totalMs / 1000).toFixed(1)}s of unit time at up to ${peakConcurrency}x${FULL ? "  (--full)" : ""}` +
    // On the headline, because a run that had to shard is a run whose green means less, and the one
    // place everybody reads is the last line.
    `${shardedUnits.length ? `  ·  \x1b[33m${shardedUnits.length} unit(s) SHARDED — degraded\x1b[0m` : ""}` +
    `${pinnedOk.length ? `  ·  \x1b[33m${pinnedOk.length} pinned\x1b[0m` : ""}` +
    `${skipDrift ? "  ·  \x1b[31mskip-ledger drift\x1b[0m" : ""}` +
    `${testCountDrift ? "  ·  \x1b[31mtest-count drift\x1b[0m" : ""}` +
    `${ledgerDrift ? "  ·  \x1b[31mexpected-failure drift\x1b[0m" : ""}` +
    `${peakRegressions.length ? `  ·  \x1b[31m${peakRegressions.length} peak regression(s)\x1b[0m` : ""}\n`,
)
// `process.exitCode`, not `process.exit()`. Nothing here holds the loop open, so setting the code and
// returning exits with the same status — and it costs nothing to keep the exit on the ordinary path.
//
// ⚠️ **The reason this rule used to give was wrong, so it is corrected rather than repeated.** It
// said `process.exit()` truncates queued writes to a pipe or a file. Measured 2026-09-02 under `bun`
// on Windows: it does not — 20 000 separate `process.stderr.write` calls followed immediately by
// `process.exit(2)` arrive complete, to a file and through a pipe, as does a single 80 MB write. The
// asynchronous cases Node documents are elsewhere again (a Windows TTY, a POSIX pipe on macOS).
//
// 🔴 **What `process.exit()` really costs here is FINALIZERS, and that half was real:** the refusal
// paths that must exit from where they stand also had to kill the pool and stop the peak sampler,
// and for a long time they did neither — the sampler's PowerShell loop outlived every one of them.
// So the refusals go through `abort`, which owns the killing, the sampler and the (synchronous)
// diagnostic; see `lib/diagnostic.ts` for why the write is synchronous anyway on a target we do not
// measure from here.
process.exitCode = failed.length || skipDrift || testCountDrift || ledgerDrift || matchedNothing || peakRegressions.length ? 1 : 0
