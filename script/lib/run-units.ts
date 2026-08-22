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
 * Only `--preload` is used today. It is listed rather than inferred because the consequence of
 * getting it wrong is silent: `./happydom.ts` read as a scan root would mark every `packages/app`
 * test "covered" by a path that runs no tests at all, and `run-units.test.ts` would go green on a
 * tree whose app suites never execute.
 */
const VALUE_FLAGS: ReadonlySet<string> = new Set(["--preload"])

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
  // file-watching library were the two the gate could not see, while the packager warned that a build
  // without it "ships NO host library — file watching is off in it".
  //
  // It depends on a BUILT artifact (`packages/host/build/host.dll`, from `bun run build.ts`). That is
  // deliberate rather than a fragility to hide: `Host.available()` returning false is the exact
  // condition that silently disables file watching, so a tree with no library should fail here and say
  // so, not report green about a capability it does not have.
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
    args: ["--conditions=browser", "--preload", "./happydom.ts", "./test-browser"],
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
