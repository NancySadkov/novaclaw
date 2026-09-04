import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { stripComments } from "./lib/source-scan"

/**
 * **ONE producer of the `novaclaw-core-test-*` temp namespace.**
 *
 * `test/fixture/tmpdir.ts` owns that prefix. It creates exactly one root per LIVE test process,
 * `novaclaw-core-test-pid<pid>/`, and on startup it REAPS every sibling root whose owning process is
 * gone — the only teardown mechanism there is, because `bun test` does not run `process.on("exit")`
 * handlers. That reap is why the namespace has to have a single owner:
 *
 *   · A second producer LEAKS. `test/effect/cross-spawn-spawner.test.ts` hand-rolled
 *     `mkdtemp(os.tmpdir(), "novaclaw-core-test-")` with no reap of its own, so a wall-clock kill or
 *     a crash left its directory behind forever. That is half of the 24 abandoned directories
 *     measured in `%TEMP%` on 2026-07-29 (dated 07-14 → 07-28, one per killed run).
 *   · A second producer can also be DELETED OUT FROM UNDER a live run. The fixture's reap parses
 *     whatever follows `novaclaw-core-test-pid` as a pid; `mkdtemp` appends exactly six characters,
 *     so `novaclaw-core-test-<6 chars>` was disjoint from it — but only by arithmetic nobody was
 *     holding in place. Shorten the fixture's infix, or lengthen a hand-rolled suffix, and an
 *     all-numeric name parses as a dead pid and a concurrent run's working directory disappears
 *     mid-test. Trading a leak for a flaky suite is a bad trade.
 *
 * Both hazards are invisible in a green run and neither fails loudly, which is todo.md ruling 1's
 * defect class exactly: an invariant about code outside its own file, with nothing to enforce it.
 * This is the enforcement. Other prefixes (`novaclaw-log-test-`, `kb-*`, …) are deliberately NOT in
 * scope — they collide with nothing; it is this prefix that has a reap pointed at it.
 */

const CORE = path.resolve(import.meta.dir, "..")

/** The file that owns the namespace, relative to `packages/core`. */
const OWNER = "test/fixture/tmpdir.ts"

/** This file necessarily names the prefix it is guarding. */
const SELF = path
  .relative(CORE, import.meta.path)
  .split(path.sep)
  .join("/")

const SKIP_DIRS = new Set(["node_modules", "dist", "out", "build", "coverage", "gen", ".git", ".turbo", ".vite"])

/** The prefix as it appears in a string literal of any quoting style. */
const CLAIMS_PREFIX = /["'`]novaclaw-core-test/

function collect(
  dir: string,
  out: { name: string; text: string }[],
  base: string = CORE,
): { name: string; text: string }[] {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(full, out, base)
      continue
    }
    if (!entry.isFile() || !/\.[cm]?tsx?$/.test(entry.name)) continue
    const name = path.relative(base, full).split(path.sep).join("/")
    out.push({ name, text: stripComments(fs.readFileSync(full, "utf8")) })
  }
  return out
}

/** Files that put the prefix in a string literal — i.e. that could CREATE such a directory. */
function producers(files: ReadonlyArray<{ name: string; text: string }>): string[] {
  return files.filter((file) => file.name !== SELF && CLAIMS_PREFIX.test(file.text)).map((file) => file.name)
}

const sources = collect(CORE, [])

/**
 * The second sweep is WORKSPACE-WIDE, and deliberately so.
 *
 * The prefix guard above is a `packages/core` matter — that namespace has a reaper pointed at it and
 * lives here. The PID-shape guard below is not: the same mistake was made independently in
 * `packages/core` and `packages/novaclaw`, which is what a repo-wide invariant looks like. Splitting
 * it into a copy per package would reproduce the very "second producer" failure this file was written
 * to prevent — one rule, one owner.
 */
const PACKAGES = path.resolve(CORE, "..")
const workspaceSources = collect(PACKAGES, [], PACKAGES)

describe("the novaclaw-core-test-* temp namespace has exactly one producer", () => {
  test("the sweep reached this package", () => {
    expect(sources.length).toBeGreaterThan(200)
    expect(sources.map((file) => file.name)).toContain(OWNER)
    expect(sources.map((file) => file.name)).toContain("test/effect/cross-spawn-spawner.test.ts")
  })

  test("only the fixture names the prefix", () => {
    expect(
      producers(sources)
        .filter((name) => name !== OWNER)
        .map(
          (name) =>
            `${name} creates temp directories in the "novaclaw-core-test-" namespace that ` +
            `${OWNER} reaps. Use \`import { tmpdir } from ".../fixture/tmpdir"\` instead — a second ` +
            "producer either leaks (no reap of its own) or gets reaped out from under a live run.",
        ),
    ).toEqual([])
  })

  test("the guard actually bites (negative control)", () => {
    // A matcher that found nothing because it can find nothing would pass forever. Run it over
    // synthetic files covering the three shapes that matter.
    expect(
      producers([
        { name: "test/offender.test.ts", text: 'await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-core-test-"))' },
        { name: "test/converged.test.ts", text: 'import { tmpdir } from "../fixture/tmpdir"' },
        { name: "test/other-prefix.test.ts", text: 'await fs.mkdtemp(path.join(os.tmpdir(), "novaclaw-log-test-"))' },
      ]),
    ).toEqual(["test/offender.test.ts"])

    // Prose ABOUT the prefix is not a producer — `cross-spawn-spawner.test.ts` explains in a comment
    // why it stopped being one, and must not be flagged for saying so.
    expect(
      producers(
        [
          {
            name: "test/prose.test.ts",
            text: '// used to be mkdtemp(os.tmpdir(), "novaclaw-core-test-")\nconst x = 1',
          },
        ].map((file) => ({ ...file, text: stripComments(file.text) })),
      ),
    ).toEqual([])

    // …and the real file this was written for is one of the converged ones.
    expect(producers(sources)).toEqual([OWNER])
  })
})

/**
 * **A PID-named path in the SHARED temp root needs a reaper — the third hazard, added 2026-08-06.**
 *
 * The guard above deliberately scoped itself to one prefix, on the reasoning that other prefixes
 * "collide with nothing". That is true of the two hazards it lists (leaking into a reaped namespace,
 * and being reaped out from under a live run) and false of a third nobody had written down:
 *
 *   · **PID REUSE POISONS THE NEXT RUN.** `messenger-initiation-budget.test.ts` named its database
 *     `os.tmpdir()/novaclaw-initiation-${process.pid}.db` and cleaned up only in `Effect.ensuring`,
 *     which a KILLED process never reaches. The gate has been killed mid-run repeatedly, so the files
 *     accumulated — **257 of them, measured in `%TEMP%` on 2026-08-06, dating back to 07-31**. Windows
 *     recycles PIDs, so a later run eventually inherited a dead run's number and opened a database
 *     whose daily budget was ALREADY SPENT. The first charge then answered `exhausted` where the test
 *     expects `charged`.
 *
 * That failure cost two batches, and the reason is worth stating: it did not look like a leak. It
 * looked like a clean content regression in an unrelated subsystem, on the same screen as a real one,
 * and only re-running in isolation distinguished them. A leak that merely wastes disk is tolerable; a
 * leak that reaches into a later run's assertions is not.
 *
 * So the rule is not about a prefix, it is about a SHAPE: interpolating `process.pid` into a path
 * rooted directly at `os.tmpdir()`. Two fixtures do exactly that and are correct, because both own a
 * PID-liveness reap (`reapAbandonedRoots`, `reapAbandonedTemplateRoots`) — which is precisely what
 * makes the shape safe and what its allowlist entry certifies.
 *
 * ⚠️ Naming a file by PID *inside an already-unique directory* is NOT this hazard and is not flagged:
 * `messenger-gateway.test.ts` does it inside a `mkdtemp` root, where the pid is redundant rather than
 * load-bearing.
 */
describe("a PID-named path in the shared temp root is reaped, or it does not exist", () => {
  /** `os.tmpdir()` (however aliased) and `process.pid` in ONE expression — the shared-root shape. */
  const SHARED_ROOT_PID = /tmpdir\(\)[^\n]*process\.pid/

  /**
   * Files allowed to build one, each because it reaps abandoned siblings by PID liveness.
   * ⚠️ Adding a name here is a claim that the file REAPS. Do not add one to silence the test.
   */
  const REAPERS: ReadonlyArray<string> = [
    "core/test/fixture/tmpdir.ts", // reapAbandonedRoots()
    "core/test/fixture/git.ts", // reapAbandonedTemplateRoots()
    "core/test/preload.ts", // reaps novaclaw-test-home/<pid> by PID liveness (added 2026-08-06)
    "novaclaw/test/fixture/fixture.ts", // reapAbandonedTemplateRoots()
    "novaclaw/test/preload.ts", // reaps novaclaw-test-data-<pid> by PID liveness (added 2026-08-06)
  ]

  // ⚠️ An allowlist entry is a CLAIM, so it is checked rather than trusted. The first draft of this
  // list certified `test/preload.ts` as "swept by the fixture roots above" — which was simply false;
  // nothing reaped `novaclaw-test-home` and it had been accumulating a directory per killed run. The
  // entry now holds because the file was FIXED, and this test is what stops the next author from
  // silencing a failure by typing a name here instead.
  const REAP_EVIDENCE = /process\.kill\([^)]*,\s*0\)/

  // This file necessarily writes the offending shape, in the negative control below. `SELF` is
  // core-relative while the workspace sweep names files package-relative, so match on the suffix
  // rather than re-deriving the path twice.
  const isSelf = (name: string) => name === SELF || name.endsWith(`/${SELF}`)

  const offenders = (files: ReadonlyArray<{ name: string; text: string }>): string[] =>
    files.filter((f) => !isSelf(f.name) && !REAPERS.includes(f.name) && SHARED_ROOT_PID.test(f.text)).map((f) => f.name)

  test("no unreaped file names a PID path at the temp root", () => {
    expect(
      offenders(workspaceSources).map(
        (name) =>
          `${name} builds a temp path from os.tmpdir() + process.pid without a reaper. A killed run ` +
          "leaves that file behind and PID reuse hands it to a LATER run as live state — the 257 " +
          'abandoned novaclaw-initiation-*.db files, and the "exhausted vs charged" flake they caused. ' +
          'Use `import { tmpdir } from ".../fixture/tmpdir"`, which is mkdtemp-unique and reaped.',
      ),
    ).toEqual([])
  })

  test("the guard bites, and does not flag the safe shape (negative control)", () => {
    expect(
      offenders([
        {
          name: "test/offender.test.ts",
          text: "const f = path.join(os.tmpdir(), `thing-${process.pid}.db`)",
        },
        // Unique-dir-then-pid: redundant, not dangerous — the directory is already per-process.
        {
          name: "test/safe-unique-dir.test.ts",
          text: 'const D = fs.mkdtempSync(path.join(os.tmpdir(), "x-"))\nconst f = path.join(D, `y-${process.pid}.db`)',
        },
        // Using the fixture is the sanctioned form.
        { name: "test/converged.test.ts", text: 'import { tmpdir } from "../fixture/tmpdir"' },
      ]),
    ).toEqual(["test/offender.test.ts"])
  })

  test("the workspace sweep really crossed the package boundary", () => {
    // A repo-wide guard that quietly only saw one package would pass forever. Pin both ends: the
    // file that motivated the rule, and a file in the OTHER package that the rule now covers.
    const names = workspaceSources.map((f) => f.name)
    expect(names).toContain("core/test/messenger-initiation-budget.test.ts")
    expect(names).toContain("novaclaw/test/preload.ts")
    expect(names.length).toBeGreaterThan(sources.length)
  })

  test("every allowlisted file actually contains a PID-liveness reap", () => {
    // The allowlist is the weak point of a ratchet like this: it is one edit away from becoming the
    // place failures go to be silenced. So each entry must show the probe that justifies it.
    const byName = new Map(workspaceSources.map((f) => [f.name, f.text]))
    const unproven = REAPERS.filter((name) => {
      const text = byName.get(name)
      return text === undefined || !REAP_EVIDENCE.test(text)
    })
    expect(
      unproven.map(
        (name) =>
          `${name} is allowlisted as a reaper but contains no \`process.kill(pid, 0)\` liveness probe. ` +
          "Either it does not reap — in which case fix the file, not the list — or the probe moved and " +
          "this evidence check needs updating deliberately.",
      ),
    ).toEqual([])
  })
})
