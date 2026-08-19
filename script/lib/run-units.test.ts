import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { join } from "node:path"
import { PACKAGES, scanRoots, type Pkg } from "./run-units"
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
