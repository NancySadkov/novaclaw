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
 *   bun run test --full       # + the rest of novaclaw, run PER-SUBDIR (see note below)
 *   bun run test --only=core
 *   bun run test --only=typecheck   # just: does the tree compile (~52 s)
 *
 * ⚠️ novaclaw is `--full` + per-subdir: its cli/server/instance integration tests each pass alone but
 * HANG when run together in one process (an undisposed InstanceStore/serve handle leak — todo.md).
 * Until that fixture leak is fixed, we run each subdir in its own process so the leak can't accumulate.
 *
 * ─── WHY A GREEN RUN MEANS SOMETHING (v0.2.0 PREP → Wave 0, 2026-07-27) ────────────────────────────
 * The binding ruling is todo.md → Standing architecture decisions: *"a check that reads as coverage
 * while being none is worse than its absence"*. Four things this file used to get wrong, and the
 * mechanism that fixes each:
 *
 *  1. **`packages/desktop` and `packages/server` were not run units at all.** Ten test files had never
 *     executed — and, because desktop's tsconfig excluded `src/**\/*.test.ts`, had never typechecked
 *     either. BOTH shipped packaging bugs (v0.0.1 and v0.1.0, AGENTS.md → Known pitfalls #0) lived in
 *     `packages/desktop`. They are run units now.
 *  2. **The HTTP/contract suites were `--full`-only**, i.e. never run day-to-day. They do not spawn
 *     servers (grepped: zero `Bun.spawn`/`spawnSync`/`spawn(` under `test/{server,v2,config,tool}`), so
 *     the hang that justifies novaclaw's `--full` gate does not apply to them. They are promoted below
 *     via PROMOTED_NOVACLAW_SUBDIRS — one list, consumed by both the fast-tier entries and `subUnits`,
 *     so a promoted subdir can never be run twice under `--full`.
 *  3. **The child's stderr was thrown away.** `stdio: "inherit"` gave live output and left the summary
 *     with nothing but `exit <n>`, which is why core's intermittent `exit 3` (~1 run in 3) was never
 *     root-caused. We now capture stderr, echo it, and put an excerpt on the summary line.
 *  4. **Skips were invisible.** Several suites are platform-gated (e.g. `core/test/session-runner.test.ts`
 *     is win32-skipped, so `runner/llm.ts` is never executed on this box) and nothing said so. The
 *     `── skipped ──` ledger below is asserted against a committed baseline, so a newly-skipped suite
 *     is a visible diff instead of a silent hole.
 *  5. **The tree was never checked to COMPILE** (added 2026-07-28, todo/test-speed.md). Bun type-strips,
 *     so a file can pass every assertion while failing `tsgo` — and on 2026-07-28 this suite was 21/21
 *     green with two uncompilable test files in the tree. `bun run typecheck` now runs as a run unit per
 *     workspace package, FIRST and one at a time; see `lib/typecheck-units.ts` for what is discovered and
 *     why it is discovered rather than listed.
 *
 * ⚠️ **Trade-off you will notice:** bun's test reporter writes to **stderr**, and `spawnSync` cannot tee.
 * Capturing stderr therefore means a run unit's output appears in one burst when that unit FINISHES
 * rather than streaming line-by-line. stdout stays inherited (a test's own `console.log` still streams),
 * and the `▶ <unit>` header still prints before the unit starts, so you always know what is running.
 * Losing per-line liveness inside one unit is worth an actionable failure report; losing the failure
 * report is not worth per-line liveness.
 */
import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

import { enforce, memoryHeadroom, topConsumers } from "./lib/heavy-guard"
import * as LedgerDrift from "./lib/ledger-drift"
import * as MemoryPlan from "./lib/memory-plan"
import * as PeakSampler from "./lib/peak-sampler"
import * as PeakSeries from "./lib/peak-series"
import { readFailingNames, stripAnsi } from "./lib/test-output"
import { isUpstreamWatcherCrash } from "./lib/upstream-crash"
import { typecheckUnits } from "./lib/typecheck-units"

/**
 * Refuse to run alongside a build, local inference server or another suite, or on a machine whose
 * commit charge is already near its limit. No override, and a real measurement is required: tests
 * are evidence, so knowingly running one in conditions that can fabricate a timeout is never useful.
 *
 * The incident-derived 6 GB floor is replaced by the planner's measured one-runtime floor. This arm
 * remains absolute: below it no shard can start without sustained paging. Per-unit resident demand is
 * judged separately in `planUnit`; builds retain the conservative 6 GB default.
 */
const enforceTestMemory = (label: string) =>
  enforce(label, process.argv, {
    allowOverride: false,
    requireMeasurement: true,
    minimumFreeBytes: MemoryPlan.MIN_VIABLE_BYTES,
  })
enforceTestMemory("the test suite")

const FULL = process.argv.includes("--full")
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length)

const PER_TEST_TIMEOUT_MS = 15_000
const PACKAGE_WALLCLOCK_MS = 150_000 // a HANG backstop, not a normal budget
// Captured stderr is held in memory. spawnSync KILLS the child on overflow and reports ENOBUFS, which
// would read exactly like a real failure — so the ceiling is set far above any plausible run (core's
// ~2k tests produce a few hundred KB) rather than at bun's 1 MB default.
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
 * `packages/novaclaw/test/` subdirs promoted OUT of the `--full` tier into fast-tier run units of their
 * own. This is the ONE list: the entries below are generated from it, and `subUnits()` skips it, so
 * `--full` cannot run a promoted subdir twice. ⚠️ These may not all pass on Windows — finding that out
 * is the point. Do not "fix" a red by removing a name here.
 *
 * `control-plane` and `fixture` joined on 2026-07-28 (todo/test-speed.md). Both are static and boot
 * nothing, so the fixture leak that keeps the rest of `novaclaw` in `--full` does not apply — but both
 * carry RATCHETS (`control-plane/workspace-layer-mirrors.test.ts` guards the one hand-maintained mirror
 * of `Workspace.layer` against a second appearing) and a ratchet nobody runs is not a ratchet. Measured
 * the same day: control-plane 15 pass / 0 skip in **1.4 s**, fixture 6 pass / 0 skip in **3.5 s** — so
 * ~5 s the default tier did not pay before, spent to make two guards real. (First-run-of-the-day cold
 * numbers were 11.6 s and 5.4 s; quote the warm ones, they are what every subsequent run costs.)
 */
const PROMOTED_NOVACLAW_SUBDIRS = ["server", "v2", "config", "tool", "control-plane", "fixture"] as const

/**
 * Hang backstops for the promoted subdirs whose HONEST runtime is near the default.
 *
 * `server` is the big one: measured 95 s and 114 s on a quiet box, then WALL-CLOCK KILLED at the 150 s
 * default on a loaded one (the same run took core from 129 s to 190 s). A kill is indistinguishable
 * from a hang in the summary and produces no parseable failure list, so an under-set backstop turns a
 * slow machine into a fake red — the exact false failure heavy-guard.ts exists to prevent.
 */
const PROMOTED_WALLCLOCK_MS: Partial<Record<(typeof PROMOTED_NOVACLAW_SUBDIRS)[number], number>> = {
  server: 300_000,
}

type Pkg = {
  name: string
  dir: string
  args: string[]
  fullOnly?: boolean
  perSubdir?: boolean
  /** Override the hang backstop for a package whose HONEST runtime is close to the default. */
  wallclockMs?: number
  /** Per-subdirectory override for an isolated full-only unit with a measured honest runtime. */
  subdirWallclockMs?: Readonly<Record<string, number>>
  /**
   * Override the PER-TEST timeout for a package with a legitimately slow single test.
   *
   * Distinct from `wallclockMs`, which bounds the whole unit. It exists for a test that does real
   * work whose cost swings with machine load — the case that motivated it was a bundling test
   * measuring 1.2 s on a quiet box and blowing the 15 s default during a full run. Raising the
   * global default instead would weaken the stuck-test guard for every other package.
   *
   * ⚠️ NO PACKAGE SETS THIS TODAY (2026-07-29). Its only user was the `sdk-next` run unit, deleted
   * with the `httpapi-codegen -> client -> sdk-next` island. Kept because the knob is two lines of
   * live mechanism (read at `perTest` below) and the next slow test wants it, not because anything
   * needs it now — if that stops being true, delete the field and the read together.
   */
  timeoutMs?: number
}

const PACKAGES: Pkg[] = [
  // The repo-root build tooling — including THIS file. Nothing here had a run unit until 2026-07-28, so
  // a test placed beside these modules would never have executed — the same "reads as coverage while
  // being none" hole the rest of this file closes. It runs with cwd=script/ because the ROOT bunfig sets
  // `[test] root = "./do-not-run-tests-from-root"` (a guard against scanning the whole monorepo);
  // script/bunfig.toml re-opens the root for this directory alone.
  //
  // ⚠️ Running its tests was only half. Bun type-STRIPS, so until 2026-07-29 these files passed every
  // assertion while `tsgo` had never compiled one of them — `script/` was not a workspace and had no
  // tsconfig. It is `@novaclaw/repo-script` now, so phase 1 below covers it as `typecheck:repo-script`
  // via the same discovery as every package. Two units, two questions, and this directory needed both.
  { name: "script", dir: "script", args: [] },
  { name: "schema", dir: "packages/schema", args: [] },
  { name: "protocol", dir: "packages/protocol", args: [] },
  { name: "effect-drizzle-sqlite", dir: "packages/effect-drizzle-sqlite", args: [] },
  { name: "http-recorder", dir: "packages/http-recorder", args: [] },
  { name: "llm", dir: "packages/llm", args: [] },
  { name: "sdk-js", dir: "packages/sdk/js", args: [] },
  { name: "session-ui", dir: "packages/session-ui", args: ["src"] },
  { name: "ui", dir: "packages/ui", args: ["src"] },
  // MEASURED 110–136 s (2026-07-27, arch review) against the 150 s default — i.e. the default was a
  // ~10% margin, and under memory pressure core was being wall-clock-killed and reported as a CRASH.
  // 300 s was a hang backstop again rather than a budget.
  //
  // 2026-08-05 — core reached it, and the note above said that is "a real regression to investigate,
  // not a cap to raise". Investigated. **It is neither.** Five runs on a quiet box (host commit 50%,
  // no strays) measured 185 s · 192 s · 208 s · 241 s and two kills at 300 s — a >55% spread with no
  // change in between. Timing every file found no hot spot: the slowest is 14 s and `test/` root is
  // 204 files at ~0.7 s each. Core grew by BREADTH (110–136 s over 300-odd files → 185–241 s over
  // 341), and the variance rides on top of that.
  //
  // So the dichotomy in the old note was false: accumulated breadth is not a regression, and a
  // backstop that fires on healthy runs destroys the only thing it is for. A hang burns the budget
  // ONCE; a too-tight backstop corrupts EVERY loaded run, and a kill is indistinguishable from a
  // crash at the summary. 600 s is ~2.5× the healthy maximum. ⚠️ The wall clock alone no longer
  // separates "hung" from "slow" here — if this one fires, read the PeakSampler pressure verdict on
  // the kill line before assuming a hang.
  { name: "core", dir: "packages/core", args: [], wallclockMs: 600_000 },
  { name: "app:unit", dir: "packages/app", args: ["--preload", "./happydom.ts", "./src"] },
  {
    name: "app:browser",
    dir: "packages/app",
    args: ["--conditions=browser", "--preload", "./happydom.ts", "./test-browser"],
  },
  // The packaging seam. `src` covers main + renderer + preload; the electron-builder config test sits at
  // the package ROOT, so it needs its own arg or it silently stays unrun (which is how it got here).
  { name: "desktop", dir: "packages/desktop", args: ["src", "electron-builder.config.test.ts"] },
  { name: "server", dir: "packages/server", args: ["src"] },
  // The HTTP/contract suites, promoted out of `--full` (see PROMOTED_NOVACLAW_SUBDIRS above). Placed
  // AFTER core deliberately: core is the memory-heaviest unit and its intermittent failure correlates
  // with memory pressure, so nothing new runs before it and its neighbourhood is unchanged.
  ...PROMOTED_NOVACLAW_SUBDIRS.map((sub) => ({
    name: `novaclaw:${sub}`,
    dir: "packages/novaclaw",
    args: [`test/${sub}/`],
    ...(PROMOTED_WALLCLOCK_MS[sub] === undefined ? {} : { wallclockMs: PROMOTED_WALLCLOCK_MS[sub] }),
  })),
  {
    name: "novaclaw",
    dir: "packages/novaclaw",
    args: [],
    fullOnly: true,
    perSubdir: true,
    // Measured isolated at 201.2 s; two exact full gates killed it at the generic 150 s
    // ceiling with host commit peaking at only 81%. Keep a hang backstop, with honest margin.
    subdirWallclockMs: { "test/cli/": 300_000 },
  },
]

/**
 * What a run unit IS, because the two kinds report differently and must not be read as one another.
 *
 * A `typecheck` unit produces no bun summary at all, so both ledgers below have to skip it — a
 * typecheck row counted as "no bun summary — crashed or killed" would be this file describing a fault
 * falsely (todo.md ruling 2) on every single green run.
 */
type Kind = "test" | "typecheck"

type Result = {
  name: string
  kind: Kind
  ok: boolean
  ms: number
  note: string
  /** Tests bun reported as skipped, or `undefined` when its summary could not be read (crash/kill). */
  skipped: number | undefined
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
 * bun's end-of-run summary looks like ` 1234 pass` / `  12 skip` / `   0 fail`, one per line. The `pass`
 * line is the POSITIVE signal that we actually reached a summary: without it we return `undefined`
 * (unknown) rather than 0, so a crashed unit never masquerades as "zero skips".
 */
function readSkipCount(output: string): number | undefined {
  const plain = stripAnsi(output)
  if (!/^\s*\d+\s+pass\b/m.test(plain)) return undefined
  let total = 0
  for (const match of plain.matchAll(/^\s*(\d+)\s+skip\b/gm)) total += Number(match[1])
  return total
}

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
 */
function reapOrphans(pid: number | undefined, label: string) {
  if (pid === undefined) return
  const survivors: number[] = []
  if (process.platform === "win32") {
    const probe = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: "utf8", timeout: 20_000 },
    )
    for (const line of (probe.stdout ?? "").split(/\r?\n/)) {
      const child = Number(line.trim())
      if (Number.isFinite(child) && child > 0) survivors.push(child)
    }
  } else {
    const probe = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8", timeout: 20_000 })
    for (const line of (probe.stdout ?? "").split("\n")) {
      const child = Number(line.trim())
      if (Number.isFinite(child) && child > 0) survivors.push(child)
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
  process.stderr.write(
    `  \x1b[33mreaped ${survivors.length} orphaned child process(es) left by the ${label} kill: ` +
      `${survivors.join(", ")}\x1b[0m\n`,
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
function readPeaks(): { commit: MemoryPlan.PeakProfile; resident: MemoryPlan.PeakProfile } {
  try {
    const parsed = JSON.parse(readFileSync(join(import.meta.dir, "test-baseline.json"), "utf8")) as {
      peaks?: Record<string, number>
      workingSets?: Record<string, number>
    }
    const valid = (values: Record<string, number> | undefined) =>
      Object.fromEntries(Object.entries(values ?? {}).filter(([, mb]) => Number.isFinite(mb) && mb > 0))
    return { commit: valid(parsed.peaks), resident: valid(parsed.workingSets) }
  } catch {
    return { commit: {}, resident: {} }
  }
}
const peakProfiles = readPeaks()

/** Every unit name this invocation could run — the candidate list for "what would still fit". */
const allUnitNames = () => PACKAGES.map((p) => p.name)

/**
 * Decide the rung for one unit, or refuse with something the reader can act on.
 *
 * ⚠️ This REPLACES the flat 6 GB free-RAM floor for tests. The reasoning, and the measurements it
 * rests on, are in `lib/memory-plan.ts` and `notes/test-harness-memory.md`.
 */
function planUnit(name: string, kind: Kind): MemoryPlan.Plan {
  // A typecheck is a different beast — `tsgo --noEmit` on `packages/novaclaw` peaks ~3.8 GB and
  // cannot be sharded at all — so it keeps the conservative floor rather than this ladder.
  const demand =
    kind === "typecheck"
      ? { commitPeakMb: 4096, residentPeakMb: 4096 }
      : MemoryPlan.demandFor(peakProfiles.commit, peakProfiles.resident, name)
  const headroom = memoryHeadroom()
  if (headroom === undefined) {
    // Fail closed, exactly as `requireMeasurement` does: an unmeasurable host is not a safe one.
    process.stderr.write(
      `\n\x1b[31mRefusing to start ${kind} unit ${name}: host memory could not be measured.\x1b[0m\n` +
        `Neither free RAM nor Windows commit charge could be read, so the harness would only be\n` +
        `guessing that this unit fits.\n\n`,
    )
    process.exit(2)
  }
  const plan = MemoryPlan.planFor(demand, headroom)
  if (plan.mode !== "refuse") return plan

  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
  const fits = MemoryPlan.unitsThatFit(peakProfiles.commit, peakProfiles.resident, allUnitNames(), headroom)
  const consumers = topConsumers()
  process.stderr.write(
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
  process.exit(2)
}

/**
 * ONE sampler for the whole suite, started before the first unit — see `lib/peak-sampler.ts` for why
 * per-unit sampling measured nothing for anything that finished in under a second.
 */
const sampler = PeakSampler.start()

/**
 * ONE stamp for the whole invocation, taken where the work starts.
 *
 * There was no run id anywhere in this file before, which is why the peak block below could only ever
 * describe the run in hand — every row of the series carries this, so "one run" is a `grep` rather
 * than a guess about which lines arrived together. `Date.now()` is enough: nothing correlates these
 * rows with anything outside this process.
 */
const RUN_STAMP = new Date().toISOString()

/** One spawn of one command, with its peak sampled. The unit-level orchestration is in `run`. */
function spawnOnce(name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number) {
  const start = Date.now()
  const proc = spawnSync("bun", argv, {
    cwd: dir,
    stdio: ["ignore", kind === "test" ? "inherit" : "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout: wallclockMs,
    killSignal: "SIGKILL",
  })
  const ms = Date.now() - start
  const captured = kind === "test" ? (proc.stderr ?? "") : `${proc.stdout ?? ""}${proc.stderr ?? ""}`
  const errno = (proc.error as NodeJS.ErrnoException | undefined)?.code
  const timedOut = proc.signal === "SIGKILL" || errno === "ETIMEDOUT"
  const ok = !timedOut && errno === undefined && proc.status === 0

  // A killed or crashed child can leave its own child alive holding gigabytes. Reap before the next
  // unit starts, or the leak makes THAT unit slower and the failure cascades. See reapOrphans above.
  if (!ok) reapOrphans(proc.pid, timedOut ? "wall-clock" : `exit ${proc.status}`)

  if (!ok) process.stderr.write(`\n\x1b[31m── captured ${kind === "test" ? "stderr" : "output"} · ${name} ──\x1b[0m\n`)
  if (captured) process.stderr.write(captured.endsWith("\n") ? captured : `${captured}\n`)
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
  if (sample.hostCommitPct !== undefined && sample.hostCommitPct >= 75) {
    const level = sample.hostCommitPct >= 90 ? "FLOOR" : "warning"
    note = `host commit ${level} — peaked ${sample.hostCommitPct}% while this unit ran (not killed; reporting phase)`
  }
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
  } else if (errno === "ENOBUFS") {
    note = `output exceeded ${CAPTURE_MAX_BYTES / 1024 / 1024} MB — the child was killed by the CAPTURE, not by a test`
  } else if (errno) {
    note = `could not run bun: ${errno}`
  } else if (!ok) {
    const excerpt = failureExcerpt(captured)
    note = `exit ${proc.status}${excerpt ? ` · ${excerpt}` : ""}`
  }

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
    upstreamCrash: kind === "test" && !ok && !timedOut && isUpstreamWatcherCrash(proc.status, captured),
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
function spawnWithUpstreamRetry(name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number) {
  const first = spawnOnce(name, kind, dir, argv, wallclockMs)
  if (!first.upstreamCrash) return first
  process.stderr.write(
    `\n\x1b[33m── ${name}: upstream Bun watcher segfault (exit 3, watcher.node, no failing assertions)\n` +
      `   — this is not your change; retrying ONCE. See todo.md's header.\x1b[0m\n`,
  )
  const second = spawnOnce(name, kind, dir, argv, wallclockMs)
  return {
    ...second,
    note: second.ok
      ? `passed on retry after an upstream watcher segfault`
      : `${second.note} · (also crashed on the first attempt)`,
  }
}

/**
 * Run one unit: pick the rung from measured headroom, spawn it whole or in shards, record what it did.
 *
 * ⚠️ **A SHARDED result is weaker than a whole one and is labelled as such everywhere it appears.**
 * Splitting changes which files share a process, and that changes behaviour — measured 2026-08-05,
 * eight green batches over `core` concealed a wedge that only exists when the unit runs whole. The
 * fallback exists so a memory-poor machine gets most of the signal, never so it can claim the gate.
 */
function run(name: string, kind: Kind, dir: string, argv: string[], wallclockMs: number) {
  // Re-check BETWEEN EVERY UNIT, not only once at suite startup. A passed test can still leak a child
  // or retain several GB; letting the next unit start is the cascading false-failure shape observed on
  // 2026-07-27. This also catches a local model or build started while the suite was in progress.
  enforceTestMemory(`${kind} unit ${name}`)
  const plan = planUnit(name, kind)
  const sharded = plan.mode === "sharded" && kind === "test" ? plan.shards : undefined

  process.stdout.write(
    `\n\x1b[1m▶ ${name}\x1b[0m${sharded ? `  \x1b[33m(low memory: split into ${sharded} shards — DEGRADED)\x1b[0m` : ""}\n`,
  )

  const runs = sharded
    ? Array.from({ length: sharded }, (_, i) =>
        spawnWithUpstreamRetry(
          `${name} shard ${i + 1}/${sharded}`,
          kind,
          dir,
          [...argv, `--shard=${i + 1}/${sharded}`],
          wallclockMs,
        ),
      )
    : [spawnWithUpstreamRetry(name, kind, dir, argv, wallclockMs)]

  const captured = runs.map((r) => r.captured).join("\n")
  // A skip count is only meaningful if EVERY shard produced a summary — one unreadable shard makes the
  // total an undercount, which the ledger would then read as a skip that disappeared.
  const perShardSkips = kind === "test" ? runs.map((r) => readSkipCount(r.captured)) : []
  const skipped =
    kind !== "test" || perShardSkips.some((s) => s === undefined)
      ? undefined
      : perShardSkips.reduce<number>((a, s) => a + (s ?? 0), 0)
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
  )

  // Only a bun test run has a skip count or a parseable failure list. Reading tsgo's output with either
  // parser would invent numbers, so a typecheck unit reports neither and both ledgers below ignore it.
  results.push({
    name,
    kind,
    ok: runs.every((r) => r.ok),
    ms: runs.reduce((a, r) => a + r.ms, 0),
    note: runs
      .map((r) => r.note)
      .filter(Boolean)
      .join(" · "),
    skipped,
    failing: kind === "test" ? [...new Set(runs.flatMap((r) => readFailingNames(r.captured)))] : [],
    ...(peakStatus === "measured" && peaks.length ? { peakMb: Math.max(...peaks) } : {}),
    ...(kind === "test" ? { peakStatus, ownTicks, ticks } : {}),
    ...(sampled.length ? { sampledMb: Math.max(...sampled) } : {}),
    ...(workingSets.length ? { workingSetMb: Math.max(...workingSets) } : {}),
    ...(foreign.length ? { foreignMb: Math.max(...foreign) } : {}),
    ...(hostCommits.length ? { hostCommitPct: Math.max(...hostCommits) } : {}),
    ...(sharded ? { shards: sharded } : {}),
  })

  // A last unit has no "next" preflight, so check after it as well. If it left the host unsafe, the
  // suite must not print green and normalize the leak as an acceptable test side effect.
  enforceTestMemory(`the host after ${kind} unit ${name}`)
}

// novaclaw's integration tests must run isolated (see header). Enumerate its test/ subdirs that hold
// test files, plus the handful of top-level test files, and run each as its own process. Subdirs
// already promoted to fast-tier run units are skipped so `--full` never runs them twice.
function subUnits(dir: string, promoted: ReadonlySet<string>): string[] {
  const root = `${dir}/test`
  const units: string[] = []
  const top: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (promoted.has(entry.name)) continue
      if (readdirSync(`${root}/${entry.name}`, { recursive: true }).some((f) => String(f).endsWith(".test.ts")))
        units.push(`test/${entry.name}/`)
    } else if (entry.name.endsWith(".test.ts")) {
      top.push(`test/${entry.name}`)
    }
  }
  return [...top, ...units]
}

const promotedSubdirs = new Set<string>(PROMOTED_NOVACLAW_SUBDIRS)

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
for (const unit of typecheckUnits(REPO_ROOT)) {
  if (ONLY && !unit.name.includes(ONLY)) continue
  run(unit.name, "typecheck", unit.dir, ["run", "typecheck"], PACKAGE_WALLCLOCK_MS)
}

/** ─── phase 2: do the tests pass ──────────────────────────────────────────────────────────────── */
for (const pkg of PACKAGES) {
  if (pkg.fullOnly && !FULL) continue
  if (ONLY && !pkg.name.includes(ONLY)) continue
  const wallclock = pkg.wallclockMs ?? PACKAGE_WALLCLOCK_MS
  const perTest = pkg.timeoutMs ?? PER_TEST_TIMEOUT_MS
  const argv = (args: string[]) => ["test", ...args, `--timeout=${perTest}`]
  if (pkg.perSubdir) {
    for (const unit of subUnits(pkg.dir, promotedSubdirs))
      run(`${pkg.name} ${unit}`, "test", pkg.dir, argv([unit]), pkg.subdirWallclockMs?.[unit] ?? wallclock)
  } else {
    run(pkg.name, "test", pkg.dir, argv(pkg.args), wallclock)
  }
}

sampler.stop()

const totalMs = results.reduce((a, r) => a + r.ms, 0)

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
  failing?: Record<string, string[]>
  /** Measured peak MB per run unit — the input to the memory ladder. See `readPeaks` above. */
  peaks?: Record<string, number>
}
const BASELINE_PATH = join(import.meta.dir, "test-baseline.json")

function readBaseline(): {
  units: Record<string, number>
  failing: Record<string, string[]>
  seeded: boolean
  broken?: string
} {
  let raw: string
  try {
    raw = readFileSync(BASELINE_PATH, "utf8")
  } catch {
    return { units: {}, failing: {}, seeded: false }
  }
  try {
    const parsed = JSON.parse(raw) as Baseline
    const units = parsed.units ?? {}
    return { units, failing: parsed.failing ?? {}, seeded: Object.keys(units).length > 0 }
  } catch (error) {
    return { units: {}, failing: {}, seeded: false, broken: error instanceof Error ? error.message : String(error) }
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
    // ⚠️ A SHARDED run's peak is recorded too, and that is sound rather than sloppy: measurement
    // shows peak is nearly FLAT in file count (784 MB for 27 files, ~1 GB for 321) because it is
    // dominated by a per-process baseline. It is also what closes the bootstrap — an unprofiled unit
    // plans with the generous default, therefore shards, and without this would never learn its own
    // number and would shard forever. Marked, so the provenance is never invisible.
    const from = r.shards ? `  (from a sharded run — one shard's peak, which measures close to the whole)` : ""
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
          bound
          ? '  \x1b[2m(absent from "peaks" — do NOT paste a bound in; see peaksUnsampledNote)\x1b[0m'
          : '  (not in profile — copy it into test-baseline.json\'s "peaks")'
        : MemoryPlan.peakRegressed(was, r.peakMb ?? 0)
          ? `  \x1b[33m<- profile says ${was}; that is a real jump, look at it\x1b[0m`
          : ""
    const thin = bound
      ? `  \x1b[2m(${r.ownTicks} sample${r.ownTicks === 1 ? "" : "s"} — a lower bound, not a peak)\x1b[0m`
      : ""
    const resident = r.workingSetMb === undefined ? "" : `  resident ${r.workingSetMb} MB`
    process.stdout.write(`  ${r.name.padEnd(30)} ${String(r.peakMb).padStart(5)}${resident}${drift}${from}${thin}\n`)
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
      r.peakStatus === "discarded"
        ? `  ${r.name.padEnd(30)} \x1b[33mDISCARDED\x1b[0m  sampled ${r.sampledMb} MB, over the ` +
            `${IMPLAUSIBLE_PEAK_MB} MB ceiling` +
            `${peakProfiles.commit[r.name] === undefined ? "" : ` (profile ${peakProfiles.commit[r.name]})`}\n` +
            `  ${" ".repeat(30)} the sampler WORKED — this is a reading, not an absence, and it is now\n` +
            `  ${" ".repeat(30)} attributed: only processes this unit itself created are in it.\n`
        : // ⚠️ THREE nulls, not two. Attribution added the middle one, and it is the benign case that
          // used to be reported as a 43 MB measurement — so it must not now be reported as an
          // instrument failure either. Say which of the three this is.
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
 * A skipped test is coverage the suite claims and does not have, and until now nothing said how much of
 * it there was. todo.md's ruling: the ledger is asserted against a COMMITTED baseline, so adding a skip
 * (a new `describe.skipIf`, a platform gate, an `it.todo`) is a visible diff in review rather than a
 * silent hole. Only units that actually RAN are compared, so `--only=` and `--full` stay usable.
 *
 * Seeding: the baseline ships with an empty `units` map because the counts can only be learned by
 * running the suite. While it is empty the ledger prints what it observed, says so, and does NOT affect
 * the exit code. Paste the observed numbers into script/test-baseline.json and commit them; from
 * then on a change to any count fails the run.
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
    `  ·  ${(totalMs / 1000).toFixed(1)}s wall${FULL ? "  (--full)" : ""}` +
    // On the headline, because a run that had to shard is a run whose green means less, and the one
    // place everybody reads is the last line.
    `${shardedUnits.length ? `  ·  \x1b[33m${shardedUnits.length} unit(s) SHARDED — degraded\x1b[0m` : ""}` +
    `${pinnedOk.length ? `  ·  \x1b[33m${pinnedOk.length} pinned\x1b[0m` : ""}` +
    `${skipDrift ? "  ·  \x1b[31mskip-ledger drift\x1b[0m" : ""}` +
    `${ledgerDrift ? "  ·  \x1b[31mexpected-failure drift\x1b[0m" : ""}` +
    `${peakRegressions.length ? `  ·  \x1b[31m${peakRegressions.length} peak regression(s)\x1b[0m` : ""}\n`,
)
// `process.exitCode`, not `process.exit()`. spawnSync blocks the event loop for the whole run, so every
// write queued while a unit was running only drains once the loop is free — and `process.exit()` would
// truncate them whenever stdout/stderr is a pipe or a file rather than a TTY. Nothing here holds the
// loop open, so setting the code and returning exits with the same status and keeps the output.
process.exitCode = failed.length || skipDrift || ledgerDrift || matchedNothing || peakRegressions.length ? 1 : 0
