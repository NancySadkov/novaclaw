import { readdirSync } from "node:fs"
import { join } from "node:path"

/**
 * The RUN-UNIT table — which directories `bun run test` actually executes, and with what arguments.
 *
 * ─── why this is a module and not a `const` inside `test.ts` ───────────────────────────────────────
 * `script/test.ts` runs the gate as a side effect of being imported, so nothing can read its unit
 * table without also running it. That made the table unobservable to any test, which is how
 * `packages/host` sat with **11 tests that had never executed in any tier** until 2026-08-19 while
 * every gate reported green.
 *
 * `lib/typecheck-units.ts` argues at length that a hand-maintained list of packages has one silent
 * failure mode — somebody adds a package and forgets — and it solves that by DISCOVERING typecheck
 * units from the workspace. Execution units cannot be discovered the same way: a unit carries
 * arguments, wall-clock budgets and tier flags that only a person can choose. So the list stays
 * hand-written, and the check moves to `run-units.test.ts`, which asserts that no workspace package
 * ships test files without a unit to run them.
 *
 * ⚠️ **The obvious check is the wrong one.** The first proposal was "fail when a package has a
 * typecheck unit and no execution unit". `packages/host` declares no `typecheck` script either, so
 * that rule would have reported the tree clean while the hole it was written for was still open.
 * The invariant that bites is about TEST FILES, not about the other list.
 */

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
export const PROMOTED_NOVACLAW_SUBDIRS = ["server", "v2", "config", "tool", "control-plane", "fixture"] as const

/**
 * Small CLI contracts promoted into the fast tier. Keep the expensive process-smoke files in the
 * full tier; these two are static/help surfaces whose drift should be visible on every edit.
 */
export const PROMOTED_NOVACLAW_TEST_FILES = [
  "test/cli/providers-login.test.ts",
  "test/cli/help/help-snapshots.test.ts",
] as const

/**
 * Full-tier NovaClaw files that require their own process window.
 *
 * Keep this list surgical. A solo file pays for another Bun process and loses the cross-file
 * composition signal, so a file joins only after the combined unit has demonstrated a concrete
 * incompatibility. `run-process.test.ts` starts nested CLI/server/session-worker processes and opens
 * the Ladybug WASM knowledge graph. In the 2026-08-31 milestone gate it shared a 69-file process that
 * peaked at 9.76 GB and Ladybug crashed with an out-of-bounds table access; the exact file then passed
 * 14/14 alone. Isolation gives the subprocess smoke a host-safe admission boundary instead of asking
 * an in-process WASM engine to survive unrelated test fan-out.
 */
export const SOLO_NOVACLAW_TEST_FILES = [
  "test/cli/lazy-command.test.ts",
  "test/cli/run/run-process.test.ts",
  "test/mcp/config-reload.test.ts",
] as const

/**
 * The `--full` tier's run units for NovaClaw: one bulk unit plus explicitly isolated files.
 *
 * This is pure gate configuration kept outside `script/test.ts` so tests can prove that an isolated
 * file is absent from bulk and still runs exactly once. Importing `test.ts` would execute the gate as
 * a side effect, which is the same unobservable-configuration hole `PACKAGES` was moved here to close.
 */
export function novaclawSubUnits(
  dir: string,
  promoted: ReadonlySet<string>,
  promotedFiles: ReadonlySet<string> = new Set(),
): { unit: string; args: string[] }[] {
  const paths: string[] = []
  const ignored = new Set([".git", "node_modules", "build", "dist", "out", ".ts-dist"])
  const walk = (relative: string) => {
    for (const entry of readdirSync(join(dir, relative), { withFileTypes: true })) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        // Promoted directories already have their own fast-tier units. This check is deliberately
        // about the package's test tree; a source directory called `server` is not promoted.
        if (relative === "test" && promoted.has(entry.name)) continue
        if (!ignored.has(entry.name)) walk(next)
      } else if (/\.test\.tsx?$/.test(entry.name) && !promotedFiles.has(next.replaceAll("\\", "/"))) {
        paths.push(next.replaceAll("\\", "/"))
      }
    }
  }
  // The package's own `bun test` script scans from its root. Discover from that same root here so
  // tests colocated with implementation (`src/**`) cannot disappear between the package script and
  // the full-tier gate. Previously this started at `test/`, leaving 21 committed source tests out of
  // every gate while `run-units.test.ts` claimed the package was covered.
  walk("")
  const solo = SOLO_NOVACLAW_TEST_FILES.filter((file) => paths.includes(file))
  const bulk = paths.filter((file) => !solo.includes(file as (typeof SOLO_NOVACLAW_TEST_FILES)[number]))
  return [
    ...(bulk.length > 0 ? [{ unit: "test/*", args: bulk }] : []),
    ...solo.map((file) => ({ unit: file, args: [file] })),
  ]
}

/**
 * Hang backstops for the promoted subdirs whose HONEST runtime is near the default.
 *
 * `server` is the big one: measured 95 s and 114 s on a quiet box, then WALL-CLOCK KILLED at the 150 s
 * default on a loaded one (the same run took core from 129 s to 190 s). A kill is indistinguishable
 * from a hang in the summary and produces no parseable failure list, so an under-set backstop turns a
 * slow machine into a fake red — the exact false failure heavy-guard.ts exists to prevent.
 *
 * ⚠️ **300 s expired, and it took two gates to notice — raised to 900 s on 2026-08-22.** The unit
 * passed at 203 s one evening and was wall-clock-killed at 300 s on the next two gates, with host
 * commit peaking at 46–48 % — so the summary's "genuine hang, not memory" line was reporting a
 * healthy run as a crash. Timed both arms of an A/B directly to settle it: **461 s with the change
 * under test (426 pass), 522 s at HEAD (427 pass)** — the unit is simply slower than it was, and the
 * arm WITHOUT the change was the slower of the two.
 *
 * A measured threshold inherits the expiry of whatever it was measured on. 900 s keeps a real hang
 * bounded (a hang runs forever; this does not) while leaving ~1.7× over the slowest honest run seen.
 */
const PROMOTED_WALLCLOCK_MS: Partial<Record<(typeof PROMOTED_NOVACLAW_SUBDIRS)[number], number>> = {
  server: 900_000,
}

/**
 * Flags that take their value as the NEXT argument rather than after an `=`.
 *
 * Only `--preload` is used by a unit today. It is listed rather than inferred because the
 * consequence of getting it wrong is silent: `./happydom.ts` read as a scan root would mark every
 * `packages/app` test "covered" by a path that runs no tests at all, and `run-units.test.ts` would go
 * green on a tree whose app suites never execute.
 *
 * ⚠️ `--timeout` is here because `scanRoots` also parses PACKAGE `test` scripts (four of them pass
 * `--timeout 30000`), and reading `30000` as a directory is the same silent mis-measurement.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--preload", "--timeout"])

/**
 * The directories a unit's `bun test` invocation actually scans, POSIX-relative to the unit's `dir`.
 *
 * An empty string means "the whole package" — a unit with no path arguments scans its cwd. Used by
 * `run-units.test.ts` to answer the question the run summary cannot: is every test file in the tree
 * inside something a unit looks at?
 */
export function scanRoots(unit: Pick<Pkg, "name" | "dir" | "args">): string[] {
  const roots: string[] = []
  for (let index = 0; index < unit.args.length; index++) {
    const arg = unit.args[index]!
    if (arg.startsWith("-")) {
      if (VALUE_FLAGS.has(arg)) index++
      continue
    }
    roots.push(arg.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, ""))
  }
  return roots.length === 0 ? [""] : roots
}

export type Pkg = {
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

export const PACKAGES: Pkg[] = [
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
  // ⚠️ `packages/script` is a DIFFERENT workspace from the `script/` directory above — `@novaclaw/script`
  // (the shared supervise/channel policy the headless server and Electron main both import) versus
  // `@novaclaw/repo-script` (this harness). Phase 1 has always typechecked it; nothing had ever RUN it,
  // because it held no test until 2026-08-29. That is the `packages/host` shape recorded below —
  // "typecheck unit and no execution unit" — caught this time on the first test rather than the
  // eleventh, and the unit is added so the NEXT test here is not decoration either.
  //
  // 🔴 The name is `script-lib`, not `script`, on purpose. Reusing the key would silently re-point every
  // `script` entry in `test-baseline.json` at a different directory — a rename that reads as a no-op in
  // the diff and moves a pinned failure onto an unrelated unit.
  { name: "script-lib", dir: "packages/script", args: [] },
  { name: "schema", dir: "packages/schema", args: [] },
  { name: "protocol", dir: "packages/protocol", args: [] },
  { name: "effect-drizzle-sqlite", dir: "packages/effect-drizzle-sqlite", args: [] },
  { name: "http-recorder", dir: "packages/http-recorder", args: [] },
  { name: "llm", dir: "packages/llm", args: [] },
  // ⚠️ ADDED 2026-08-19, and it had never run in ANY tier — not the fast one, not `--full`. Eleven
  // tests, 143 ms, green from the first run: `wire.test.ts` pins the `host.h` decode (the one place a
  // silent mistake produces WRONG PATHS instead of an error) and `host.node.test.ts` exercises the
  // NODE twin against a real filesystem, which is the runtime the desktop sidecar actually ships on —
  // an Electron `utilityProcess`, where `bun:ffi` does not exist. So the two suites that cover the
  // file-watching package were the two the gate could not see, while the packager warned that a build
  // without it "ships NO host library — file watching is off in it".
  //
  // 🔴 **This unit does NOT depend on the built library, and saying it did was the bug.** Neither
  // suite loads it: `wire.test.ts` is pure by design and `host.node.test.ts` imports `./host.node`,
  // which uses `fs.watch`. Nothing here imports `host.bun.ts`, so `dlopen` is never called. Measured
  // 2026-09-01: 11/11 green with `NOVACLAW_HOST_LIB` pointed at a path that does not exist.
  //
  // What that leaves uncovered is the half whose failure mode is SILENT ABSENCE: `host.bun.ts`'s
  // candidate ladder (`execPath` → `process.resourcesPath/host` → source tree), its ABI-version
  // refusal, and its poll/decode loop. `Host.available()` returning false is what quietly turns file
  // watching off, and no test in the tree asserts it is true on a built tree. `NOVACLAW_HOST_LIB` is
  // the seam a `host.bun.test.ts` would use.
  { name: "host", dir: "packages/host", args: ["src"] },
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
    // ⚠️ `solid-preload.ts` is REQUIRED, not optional: without it `bun test` compiles JSX with its own
    // React transform and every `.tsx` import dies on `ReferenceError: React is not defined`. It is
    // listed HERE as well as in the package's `test:browser` script because this array — not the
    // script — is what the gate runs, and wiring only the script left the gate red while a direct
    // `bun run test:browser` was green.
    args: [
      "--conditions=browser",
      "--preload",
      "./happydom.ts",
      "--preload",
      "./solid-preload.ts",
      "./test-browser",
    ],
  },
  // The packaging seam. `src` covers main + renderer + preload; the electron-builder config test sits at
  // the package ROOT, so it needs its own arg or it silently stays unrun (which is how it got here).
  //
  // ⚠️ `scripts` joined 2026-08-19 and it is the SAME defect a third time, found by `run-units.test.ts`
  // the first time that check ever ran: `scripts/prepare-w64devkit.test.ts` was outside every scanned
  // path, so it had never executed. It pins the embedded w64devkit archive's hash **and the exact
  // corresponding source archive's hash** — a licence-compliance obligation, i.e. a guard whose silence
  // is expensive in a way a normal test's is not. Green in 131 ms once run.
  { name: "desktop", dir: "packages/desktop", args: ["src", "electron-builder.config.test.ts", "scripts"] },
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
    name: "novaclaw:cli-contract",
    dir: "packages/novaclaw",
    args: [...PROMOTED_NOVACLAW_TEST_FILES],
  },
  {
    name: "novaclaw",
    dir: "packages/novaclaw",
    args: [],
    fullOnly: true,
    perSubdir: true,
    // 🔴 `test/*` is now ONE unit — the per-subdir split's reason (a hang) was measured gone on
    // 2026-08-24; see `subUnits` in test.ts. Measured 273 s for all 69 files together, so 900 s keeps
    // a real hang bounded (a hang runs forever; this does not) with honest margin over the slowest
    // honest run — the same reasoning `server` above carries, and the same lesson: an under-set
    // backstop turns a slow machine into a fake red.
    //
    // `run-process.test.ts` measured 187.75 s when run alone on 2026-08-31, then 310.1 s on the
    // 2026-09-07 release host after the suite grew to fifteen real subprocess cases. A 300 s bound
    // killed it after fourteen PASS results with no assertion failure. 420 s restores measured
    // headroom while still bounding an actual hang.
    subdirWallclockMs: {
      "test/*": 900_000,
      "test/cli/run/run-process.test.ts": 420_000,
    },
  },
]
