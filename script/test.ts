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
 *   bun run test          # the fast tier: kernel, schemas, LLM, SDK, UI, desktop, server, HTTP contract
 *   bun run test --full   # + the rest of novaclaw, run PER-SUBDIR (see note below)
 *   bun run test --only=core
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

import { enforce } from "./lib/heavy-guard"

// Refuse to run alongside a build or another suite, or on a machine already short of memory. Both
// mistakes produce the same thing: a wall-clock kill that looks exactly like a real test failure, plus
// pagefile thrashing that wears the SSD. `--force` overrides; CI is exempt. See lib/heavy-guard.ts.
enforce("the test suite")

const FULL = process.argv.includes("--full")
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice("--only=".length)

const PER_TEST_TIMEOUT_MS = 15_000
const PACKAGE_WALLCLOCK_MS = 150_000 // a HANG backstop, not a normal budget
// Captured stderr is held in memory. spawnSync KILLS the child on overflow and reports ENOBUFS, which
// would read exactly like a real failure — so the ceiling is set far above any plausible run (core's
// ~2k tests produce a few hundred KB) rather than at bun's 1 MB default.
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024

/**
 * `packages/novaclaw/test/` subdirs promoted OUT of the `--full` tier into fast-tier run units of their
 * own. This is the ONE list: the entries below are generated from it, and `subUnits()` skips it, so
 * `--full` cannot run a promoted subdir twice. ⚠️ These may not all pass on Windows — finding that out
 * is the point. Do not "fix" a red by removing a name here.
 */
const PROMOTED_NOVACLAW_SUBDIRS = ["server", "v2", "config", "tool"] as const

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
}

const PACKAGES: Pkg[] = [
  // The repo-root build tooling. `script/` is not a package, so nothing here had a run unit and a test
  // placed beside these modules would never have executed — the same "reads as coverage while being
  // none" hole the rest of this file closes. It runs with cwd=script/ because the ROOT bunfig sets
  // `[test] root = "./do-not-run-tests-from-root"` (a guard against scanning the whole monorepo);
  // script/bunfig.toml re-opens the root for this directory alone.
  { name: "script", dir: "script", args: [] },
  { name: "schema", dir: "packages/schema", args: [] },
  { name: "protocol", dir: "packages/protocol", args: [] },
  { name: "client", dir: "packages/client", args: [] },
  { name: "sdk-next", dir: "packages/sdk-next", args: ["test/import-boundaries.test.ts"] },
  { name: "httpapi-codegen", dir: "packages/httpapi-codegen", args: [] },
  { name: "effect-drizzle-sqlite", dir: "packages/effect-drizzle-sqlite", args: [] },
  { name: "http-recorder", dir: "packages/http-recorder", args: [] },
  { name: "llm", dir: "packages/llm", args: [] },
  { name: "sdk-js", dir: "packages/sdk/js", args: [] },
  { name: "session-ui", dir: "packages/session-ui", args: ["src"] },
  { name: "ui", dir: "packages/ui", args: ["src"] },
  // MEASURED 110–136 s (2026-07-27, arch review) against the 150 s default — i.e. the default was a
  // ~10% margin, and under memory pressure core was being wall-clock-killed and reported as a CRASH.
  // 300 s is a hang backstop again rather than a budget. This number is evidence, not a guess; if core
  // ever approaches it, that is a real regression to investigate, not a cap to raise.
  { name: "core", dir: "packages/core", args: [], wallclockMs: 300_000 },
  { name: "app:unit", dir: "packages/app", args: ["--preload", "./happydom.ts", "./src"] },
  { name: "app:browser", dir: "packages/app", args: ["--conditions=browser", "--preload", "./happydom.ts", "./test-browser"] },
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
  { name: "novaclaw", dir: "packages/novaclaw", args: [], fullOnly: true, perSubdir: true },
]

type Result = {
  name: string
  ok: boolean
  ms: number
  note: string
  /** Tests bun reported as skipped, or `undefined` when its summary could not be read (crash/kill). */
  skipped: number | undefined
  /** The names bun reported as failing, for the expected-failure ledger. */
  failing: string[]
}
const results: Result[] = []

// Built from a char code so no literal control byte is ever authored into this file.
const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g")
const stripAnsi = (text: string) => text.replace(ANSI, "")

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
 * The names bun reported as failing, e.g. `(fail) config HttpApi > serves config update [34ms]`. The
 * trailing duration is stripped so a baseline is not invalidated by timing jitter.
 */
function readFailingNames(output: string): string[] {
  return [...stripAnsi(output).matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)]
    .map((match) => match[1]!.trim())
    .sort()
}

/** The most actionable single line we can put on a summary row. */
function failureExcerpt(output: string): string {
  const lines = stripAnsi(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const pick = lines.find((line) => /^error[:\s]/i.test(line)) ?? lines.find((line) => line.includes("(fail)")) ?? lines.at(-1)
  if (!pick) return ""
  return pick.length > 140 ? `${pick.slice(0, 137)}...` : pick
}

function run(name: string, dir: string, args: string[], wallclockMs: number) {
  process.stdout.write(`\n\x1b[1m▶ ${name}\x1b[0m\n`)
  const start = Date.now()
  // stdout stays inherited so a test's own console output streams; stderr is piped because that is
  // where bun's reporter writes — and a failure we cannot read is a failure we cannot fix.
  const proc = spawnSync("bun", ["test", ...args, `--timeout=${PER_TEST_TIMEOUT_MS}`], {
    cwd: dir,
    stdio: ["ignore", "inherit", "pipe"],
    encoding: "utf8",
    maxBuffer: CAPTURE_MAX_BYTES,
    timeout: wallclockMs,
    killSignal: "SIGKILL",
  })
  const ms = Date.now() - start
  const captured = proc.stderr ?? ""
  const errno = (proc.error as NodeJS.ErrnoException | undefined)?.code
  const timedOut = proc.signal === "SIGKILL" || errno === "ETIMEDOUT"
  const ok = !timedOut && errno === undefined && proc.status === 0

  if (!ok) process.stderr.write(`\n\x1b[31m── captured stderr · ${name} ──\x1b[0m\n`)
  if (captured) process.stderr.write(captured.endsWith("\n") ? captured : `${captured}\n`)
  else if (!ok)
    process.stderr.write(
      `  (nothing was captured — bun BLOCK-BUFFERS redirected output, so a child killed mid-run usually\n` +
        `   flushes nothing. Silence here is a property of the kill, not evidence the child was quiet.)\n`,
    )

  let note = ""
  if (timedOut) {
    note = `WALL-CLOCK KILL at ${wallclockMs / 1000}s (hang; a SIGKILLed bun child often flushes no stderr)`
  } else if (errno === "ENOBUFS") {
    note = `stderr exceeded ${CAPTURE_MAX_BYTES / 1024 / 1024} MB — the child was killed by the CAPTURE, not by a test`
  } else if (errno) {
    note = `could not run bun: ${errno}`
  } else if (!ok) {
    const excerpt = failureExcerpt(captured)
    note = `exit ${proc.status}${excerpt ? ` · ${excerpt}` : ""}`
  }

  results.push({ name, ok, ms, note, skipped: readSkipCount(captured), failing: readFailingNames(captured) })
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

for (const pkg of PACKAGES) {
  if (pkg.fullOnly && !FULL) continue
  if (ONLY && !pkg.name.includes(ONLY)) continue
  const wallclock = pkg.wallclockMs ?? PACKAGE_WALLCLOCK_MS
  if (pkg.perSubdir) {
    for (const unit of subUnits(pkg.dir, promotedSubdirs)) run(`${pkg.name} ${unit}`, pkg.dir, [unit], wallclock)
  } else {
    run(pkg.name, pkg.dir, pkg.args, wallclock)
  }
}

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
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const pinnedOk: Result[] = []
const failed: Result[] = []
for (const r of results) {
  if (r.ok) continue
  const pinned = expectedFailures.get(r.name)
  // Only an assertion-level failure can be pinned. A wall-clock kill or a spawn error produces no
  // parseable list, and pinning "the unit died" would hide exactly the thing worth seeing.
  if (pinned && r.failing.length > 0 && sameSet(pinned, r.failing)) pinnedOk.push(r)
  else failed.push(r)
}
const isPinned = (r: Result) => pinnedOk.includes(r)

process.stdout.write(`\n\x1b[1m── summary ──\x1b[0m\n`)
for (const r of results) {
  const tag = r.ok ? "\x1b[32mPASS\x1b[0m" : isPinned(r) ? "\x1b[33mPINN\x1b[0m" : "\x1b[31mFAIL\x1b[0m"
  const note = isPinned(r) ? `${r.failing.length} pinned failure(s) — see ${BASELINE_PATH}` : r.note
  process.stdout.write(`  ${tag}  ${r.name.padEnd(30)} ${(r.ms / 1000).toFixed(1)}s  ${note}\n`)
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
const observed = results.filter((r) => r.skipped !== undefined)
const unreadable = results.filter((r) => r.skipped === undefined)
const totalSkipped = observed.reduce((a, r) => a + (r.skipped ?? 0), 0)

process.stdout.write(`\n\x1b[1m── skipped ──\x1b[0m\n`)
if (results.length && !observed.length) {
  // Every unit unreadable is not N crashes — it means bun's summary is no longer on the stream we
  // capture (it writes the reporter to stderr today). Say that once instead of N times.
  process.stdout.write(
    `  \x1b[33mNO RUN UNIT PRODUCED A READABLE BUN SUMMARY\x1b[0m — the ledger could not be built.\n` +
      `  If the units themselves passed, bun's reporter moved off stderr and readSkipCount() needs updating.\n`,
  )
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
  process.stdout.write(`\n  \x1b[31mBASELINE UNREADABLE\x1b[0m — script/test-baseline.json is not valid JSON: ${baseline.broken}\n`)
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
    process.stdout.write(`\n  \x1b[31mSKIP COUNTS CHANGED\x1b[0m — update script/test-baseline.json in the same commit:\n`)
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
  if (sameSet(pinned, result.failing)) continue
  ledgerDrift = true
  const fixed = pinned.filter((name) => !result.failing.includes(name))
  const fresh = result.failing.filter((name) => !pinned.includes(name))
  process.stdout.write(`\n  \x1b[31mEXPECTED-FAILURE DRIFT · ${unit}\x1b[0m\n`)
  for (const name of fresh) process.stdout.write(`    \x1b[31m+ NEW FAILURE\x1b[0m   ${name}\n`)
  for (const name of fixed)
    process.stdout.write(`    \x1b[32m- now passing\x1b[0m   ${name}   (remove it from ${BASELINE_PATH})\n`)
}
if (pinnedOk.length) {
  process.stdout.write(`\n\x1b[33m── pinned failures (expected, filed) ──\x1b[0m\n`)
  for (const r of pinnedOk) process.stdout.write(`  ${r.name.padEnd(30)} ${r.failing.length} known failure(s)\n`)
}

process.stdout.write(
  `\n${failed.length || ledgerDrift ? "\x1b[31m" : "\x1b[32m"}${results.length - failed.length}/${results.length} run units green` +
    `\x1b[0m  ·  ${(totalMs / 1000).toFixed(1)}s wall${FULL ? "  (--full)" : ""}` +
    `${pinnedOk.length ? `  ·  \x1b[33m${pinnedOk.length} pinned\x1b[0m` : ""}` +
    `${skipDrift ? "  ·  \x1b[31mskip-ledger drift\x1b[0m" : ""}` +
    `${ledgerDrift ? "  ·  \x1b[31mexpected-failure drift\x1b[0m" : ""}\n`,
)
// `process.exitCode`, not `process.exit()`. spawnSync blocks the event loop for the whole run, so every
// write queued while a unit was running only drains once the loop is free — and `process.exit()` would
// truncate them whenever stdout/stderr is a pipe or a file rather than a TTY. Nothing here holds the
// loop open, so setting the code and returning exits with the same status and keeps the output.
process.exitCode = failed.length || skipDrift || ledgerDrift ? 1 : 0
