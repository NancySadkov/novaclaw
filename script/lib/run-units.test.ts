import { describe, expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import {
  novaclawSubUnits,
  PACKAGES,
  PROMOTED_NOVACLAW_SUBDIRS,
  PROMOTED_NOVACLAW_TEST_FILES,
  scanRoots,
  SOLO_NOVACLAW_TEST_FILES,
  type Pkg,
} from "./run-units"
import { workspacePackageDirs } from "./typecheck-units"

/**
 * DOES THE GATE ACTUALLY RUN THE TESTS IN THE TREE?
 *
 * `bun run test` reported green for months while `packages/host`'s **11 tests had never executed in
 * any tier** — not the fast one, not `--full`. Nothing was broken and nothing was skipped: the
 * package simply had no run unit, and a directory nobody names is a directory nobody runs. The
 * summary line counts the units that ran, so an absent unit is invisible by construction.
 *
 * That is the same "reads as coverage while being none" hole `script/test.ts` was written to close,
 * one level up — and `lib/typecheck-units.ts` already closed its half by DISCOVERING typecheck units
 * from the workspace instead of listing them. Execution units cannot be discovered that way (a unit
 * carries arguments, budgets and tier flags a person must choose), so the list stays hand-written and
 * this file is the check that it is complete.
 *
 * ⚠️ **A `fullOnly` unit counts as coverage here, deliberately.** The defect is "runs in NO tier",
 * not "runs outside the fast tier" — `packages/novaclaw`'s elective unit is how most of that package
 * is reached, and calling it uncovered would report a hole that is not one.
 */

const ROOT = join(import.meta.dir, "..", "..")
const IGNORED = new Set(["node_modules", "dist", "build", "out", ".git", "gen"])

/** Every `*.test.ts`/`*.test.tsx` under `dir`, POSIX-relative to it. */
function testFiles(dir: string): string[] {
  const found: string[] = []
  const walk = (relative: string) => {
    let entries
    try {
      entries = readdirSync(join(dir, relative), { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const next = relative === "" ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        if (!IGNORED.has(entry.name)) walk(next)
      } else if (/\.test\.tsx?$/.test(entry.name)) found.push(next)
    }
  }
  walk("")
  return found.sort()
}

/** The units that execute a given workspace package, whatever tier they belong to. */
const unitsFor = (units: readonly Pkg[], packageDir: string): Pkg[] =>
  units.filter((unit) => unit.dir.replaceAll("\\", "/") === packageDir)

const packagesWithTests = () =>
  workspacePackageDirs(ROOT)
    .map((dir) => ({ dir, tests: testFiles(join(ROOT, dir)) }))
    .filter((entry) => entry.tests.length > 0)

/** Packages that ship test files no unit in `units` would execute. The check, as a function. */
const orphanedPackages = (units: readonly Pkg[]) =>
  packagesWithTests()
    .filter((entry) => unitsFor(units, entry.dir).length === 0)
    .map((entry) => `${entry.dir} (${entry.tests.length} test file(s): ${entry.tests.join(", ")})`)

describe("every test file in the tree belongs to a run unit", () => {
  test("no workspace package ships tests with no unit to run them", () => {
    const orphaned = orphanedPackages(PACKAGES)
    expect(
      orphaned,
      "a workspace package has test files and no run unit in `lib/run-units.ts`, so `bun run test` " +
        "reports green without ever executing them. This is how `packages/host` hid 11 tests. Add a " +
        "unit — do not add the package to an ignore list.",
    ).toEqual([])
  })

  test("no test file sits outside the paths its package's units actually scan", () => {
    // The second half of the same hole, and it has bitten here before: `packages/desktop`'s
    // `electron-builder.config.test.ts` sits at the package ROOT while the unit scanned only `src`,
    // so the file stayed unrun even though the package had a unit. A unit's ARGUMENTS decide what
    // runs, not its existence.
    const uncovered: string[] = []
    for (const entry of packagesWithTests()) {
      const units = unitsFor(PACKAGES, entry.dir)
      if (units.length === 0) continue // reported by the case above; not double-counted here
      const roots = units.flatMap(scanRoots)
      for (const file of entry.tests)
        if (!roots.some((root) => root === "" || file === root || file.startsWith(`${root}/`)))
          uncovered.push(`${entry.dir}/${file}`)
    }
    expect(
      uncovered,
      "a test file is outside every path its package's run units scan, so it never executes. Widen " +
        "the unit's args (or add a unit) rather than moving the test.",
    ).toEqual([])
  })
})

test("promoted CLI contract files are removed from the full bulk unit", () => {
  const subUnits = novaclawSubUnits(
    join(ROOT, "packages/novaclaw"),
    new Set(PROMOTED_NOVACLAW_SUBDIRS),
    new Set(PROMOTED_NOVACLAW_TEST_FILES),
  )
  const bulk = subUnits.find((unit) => unit.unit === "test/*")
  expect(bulk).toBeDefined()
  for (const file of PROMOTED_NOVACLAW_TEST_FILES) expect(bulk?.args).not.toContain(file)

  const cliUnit = PACKAGES.find((unit) => unit.name === "novaclaw:cli-contract")
  expect(cliUnit?.args).toEqual([...PROMOTED_NOVACLAW_TEST_FILES])
})

/**
 * THE SECOND LIST. The gate spawns `bun test <args>` straight from the table and never goes through
 * a package's `test` script, so the two are free to drift — and `packages/desktop` had: the table
 * gained `scripts` on 2026-08-19 (for `prepare-w64devkit.test.ts`, a licence-compliance hash guard)
 * and the package script did not, so `bun --cwd packages/desktop test` ran everything EXCEPT that
 * guard. Whichever list someone trusts, they were trusting the wrong one half the time.
 *
 * The invariant is about WHAT RUNS, not about the argv: flags may differ (`--only-failures`,
 * `--timeout`, `--watch`) because they change how a run reports, not which files it executes. A
 * package with no `test` script has only one list and is not drift; it is simply not reachable from
 * its own directory, which fails loudly rather than silently.
 */
const scriptScanRoots = (scripts: Readonly<Record<string, string>>, name: string, seen = new Set<string>()): string[] => {
  const body = scripts[name]
  if (body === undefined || seen.has(name)) return []
  seen.add(name)
  const roots: string[] = []
  for (const command of body.split("&&").map((part) => part.trim())) {
    const argv = command.split(/\s+/).filter((token) => token.length > 0)
    if (argv[0] !== "bun") continue
    if (argv[1] === "run") {
      roots.push(...scriptScanRoots(scripts, argv[2] ?? "", seen))
      continue
    }
    if (argv[1] !== "test") continue
    roots.push(...scanRoots({ name, dir: ".", args: argv.slice(2) }))
  }
  return roots
}

/**
 * Which of `files` a set of scan roots reaches. Compared as FILES, not as root strings: `packages/
 * novaclaw`'s elective whole-package unit and its six promoted subdir units are one root and six,
 * and they cover exactly the same files, which is the property that matters.
 */
const reached = (roots: readonly string[], files: readonly string[]) =>
  files.filter((file) => roots.some((root) => root === "" || file === root || file.startsWith(`${root}/`)))

const scriptDrift = (units: readonly Pkg[]) => {
  const drifted: string[] = []
  for (const entry of packagesWithTests()) {
    const mine = unitsFor(units, entry.dir)
    if (mine.length === 0) continue
    let scripts: Record<string, string> = {}
    try {
      scripts = JSON.parse(readFileSync(join(ROOT, entry.dir, "package.json"), "utf8")).scripts ?? {}
    } catch {
      continue
    }
    if (scripts["test"] === undefined) continue
    const fromScript = new Set(reached(scriptScanRoots(scripts, "test"), entry.tests))
    const fromUnits = reached(mine.flatMap(scanRoots), entry.tests)
    const missed = fromUnits.filter((file) => !fromScript.has(file))
    const extra = [...fromScript].filter((file) => !fromUnits.includes(file))
    if (missed.length > 0 || extra.length > 0)
      drifted.push(
        `${entry.dir}: the package \`test\` script skips [${missed.join(", ")}]` +
          (extra.length > 0 ? ` and runs [${extra.join(", ")}] the gate does not` : ""),
      )
  }
  return drifted
}

describe("a package's `test` script and its run units run the same files", () => {
  test("no package's `test` script scans a different set of roots than its units", () => {
    expect(
      scriptDrift(PACKAGES),
      "a package's `test` script and `lib/run-units.ts` disagree about which directories hold its " +
        "tests, so running one is not running the other. Fix the package script — the TABLE is what " +
        "the gate executes.",
    ).toEqual([])
  })

  test("the drift check can fail — removing a root from a unit reproduces the desktop hole", () => {
    // Negative control. Asserting an empty list passes just as happily when the parser found no
    // scripts at all, so drop `scripts` from the desktop unit and require the check to name it.
    const narrowed = PACKAGES.map((unit) =>
      unit.dir === "packages/desktop" ? { ...unit, args: unit.args.filter((arg) => arg !== "scripts") } : unit,
    )
    expect(scriptDrift(narrowed).join(" | "), "the drift check reported clean on a table it should refuse").toContain(
      "packages/desktop",
    )
  })

  test("the script parser reads real scripts, not nothing", () => {
    // `packages/app`'s `test` is `bun run test:unit && bun run test:browser`, so a parser that only
    // understood a literal `bun test` would report it as scanning nothing and call it drift-free.
    const scripts = JSON.parse(readFileSync(join(ROOT, "packages/app/package.json"), "utf8")).scripts
    expect(scriptScanRoots(scripts, "test").sort()).toEqual(["src", "test-browser"])
  })
})

describe("the check itself can fail", () => {
  // ⚠️ Negative controls, because both cases above assert an EMPTY list — the shape that passes
  // just as happily when the walk finds nothing at all. A green run has to mean the tree was read.
  test("the tree walk actually finds test files", () => {
    const withTests = packagesWithTests()
    expect(withTests.length, "the walk found no package with tests — it is measuring nothing").toBeGreaterThan(5)
    expect(withTests.map((entry) => entry.dir)).toContain("packages/host")
  })

  test("deleting the `host` unit reproduces the exact hole this file was written for", () => {
    // The real negative control: run the check against a unit table with `packages/host` removed and
    // require that it names it. Asserting an empty list passes just as well when the check is inert,
    // so the only proof that it works is watching it fail on a tree it should refuse.
    const withoutHost = PACKAGES.filter((unit) => unit.dir !== "packages/host")
    expect(withoutHost.length, "the host unit was not in the table to remove").toBe(PACKAGES.length - 1)
    expect(
      orphanedPackages(withoutHost).join(" | "),
      "with the host unit removed the check still reported a clean tree — it is not measuring anything",
    ).toContain("packages/host")
    // ...and it is clean again with the unit restored, so the finding tracks the table, not the walk.
    expect(orphanedPackages(PACKAGES)).toEqual([])
  })

  test("scanRoots drops flags and flag VALUES, not just flags", () => {
    // `--preload ./happydom.ts` is the case that matters: the path after the flag is a preload
    // script, not a directory to scan, and treating it as a scan root would mark every app test
    // covered by a file that runs no tests at all.
    expect(scanRoots({ name: "x", dir: "d", args: ["--preload", "./happydom.ts", "./src"] })).toEqual(["src"])
    expect(scanRoots({ name: "x", dir: "d", args: ["--conditions=browser", "./test-browser"] })).toEqual([
      "test-browser",
    ])
    expect(scanRoots({ name: "x", dir: "d", args: [] })).toEqual([""])
    expect(scanRoots({ name: "x", dir: "d", args: ["test/server/"] })).toEqual(["test/server"])
  })
})

describe("NovaClaw full-tier process boundaries", () => {
  test("the full tier discovers tests beside source as well as under test/", () => {
    const units = novaclawSubUnits(join(ROOT, "packages/novaclaw"), new Set(PROMOTED_NOVACLAW_SUBDIRS))
    const sourceTests = units.flatMap((unit) => unit.args).filter((file) => file.startsWith("src/") && file.endsWith(".test.ts"))

    expect(sourceTests.length, "the full-tier discovery must not silently ignore colocated source tests").toBeGreaterThan(0)
    expect(sourceTests).toContain("src/cli/supervise.test.ts")
  })

  test("every solo file runs exactly once and never shares the bulk process", () => {
    const units = novaclawSubUnits(join(ROOT, "packages/novaclaw"), new Set(PROMOTED_NOVACLAW_SUBDIRS))
    const bulk = units.find((unit) => unit.unit === "test/*")
    expect(bulk, "the full tier lost its bulk unit and therefore most of its composition signal").toBeDefined()

    const allArgs = units.flatMap((unit) => unit.args)
    for (const file of SOLO_NOVACLAW_TEST_FILES) {
      expect(
        units.find((unit) => unit.unit === file)?.args,
        `${file} is declared solo but has no dedicated unit`,
      ).toEqual([file])
      expect(bulk!.args, `${file} still runs inside the memory-contended bulk process`).not.toContain(file)
      expect(allArgs.filter((arg) => arg === file), `${file} must run exactly once`).toHaveLength(1)
    }
  })

  test("the subprocess-heavy CLI smoke keeps its measured wall-clock margin", () => {
    const unit = PACKAGES.find((candidate) => candidate.name === "novaclaw")
    expect(unit, "the full-tier NovaClaw unit vanished").toBeDefined()
    expect(unit!.subdirWallclockMs?.["test/cli/run/run-process.test.ts"]).toBe(420_000)
  })
})
