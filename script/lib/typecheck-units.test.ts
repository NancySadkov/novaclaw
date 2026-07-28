import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { TYPECHECK_PREFIX, typecheckUnits, workspacePackageDirs } from "./typecheck-units"

// The gate's typecheck phase is only as real as its coverage. `script/test.ts` runs one unit per
// workspace package that declares a `typecheck` script — so the failure that would quietly undo the
// whole thing is a NEW package that the discovery never sees: it is never typechecked, and the summary
// still reports every unit green. That is the "reads as coverage while being none" hole (todo.md ruling
// 1 / ruling 2), one level up from the one `script/test.ts` was written to close.
//
// So the assertions below compare the discovery against an INDEPENDENT expansion of the same workspace
// globs — bun's own `Bun.Glob`, not the hand-rolled expander in typecheck-units.ts. A test that reused
// that expander would agree with it about a package neither of them can see.
//
// ⚠️ This file is itself proof of the residual hole it cannot close: `script/` is not a workspace
// package and has no tsconfig, so nothing typechecks `script/test.ts`, `script/lib/*.ts`, or this test.
// Filed 2026-07-28 with the phase; the fix is a `script/tsconfig.json` plus one extra unit.

const ROOT = join(import.meta.dir, "..", "..")

type Manifest = {
  readonly scripts?: { readonly typecheck?: string }
  readonly workspaces?: { readonly packages?: readonly string[] }
}
const readManifest = (file: string): Manifest => JSON.parse(readFileSync(file, "utf8")) as Manifest

/** The workspace globs, expanded by bun rather than by the module under test. */
function packagesDeclaringTypecheck(root: string): Set<string> {
  const patterns = readManifest(join(root, "package.json")).workspaces?.packages ?? []
  const found = new Set<string>()
  for (const pattern of patterns)
    for (const file of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const dir = dirname(file).replaceAll("\\", "/")
      if (dir.includes("node_modules")) continue
      if (typeof readManifest(join(root, file)).scripts?.typecheck === "string") found.add(dir)
    }
  return found
}

/** A throwaway workspace: `{ dir: typecheckScript | null }`, plus whatever root fields the case needs. */
const fixtures: string[] = []
function fixtureRepo(packages: Record<string, string | null>, rootFields: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "typecheck-units-"))
  fixtures.push(root)
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-root", workspaces: { packages: ["packages/*"] }, ...rootFields }),
  )
  for (const [dir, script] of Object.entries(packages)) {
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(
      join(root, dir, "package.json"),
      JSON.stringify({
        name: `@fixture/${dir.split("/").pop()}`,
        ...(script === null ? {} : { scripts: { typecheck: script } }),
      }),
    )
  }
  return root
}
afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true })
})

describe("typecheck run units", () => {
  test("covers every workspace package that declares a typecheck script", () => {
    // THE assertion. If it fails saying a directory is missing, a package was added and the gate is not
    // typechecking it — fix the discovery, never this expectation.
    const expected = packagesDeclaringTypecheck(ROOT)
    expect([...new Set(typecheckUnits(ROOT).map((unit) => unit.dir))].sort()).toEqual([...expected].sort())
    // Guards the guard: an empty walk or a broken glob makes the line above vacuously true. Measured
    // 2026-07-28: 19 packages declare a typecheck script (18, plus packages/script added that day).
    expect(expected.size).toBeGreaterThanOrEqual(18)
  })

  test("includes packages/script, which declared no typecheck script until 2026-07-28", () => {
    // The specific hole this change closed, named so a silent removal reads as itself. `@novaclaw/script`
    // is a real workspace package (`src/index.ts`); it is NOT the repo-root `script/` build-tooling
    // directory that the `script` TEST unit covers. Two different things, one word.
    expect(typecheckUnits(ROOT).map((unit) => unit.dir)).toContain("packages/script")
  })

  test("never runs the repo root, whose typecheck fans out through turbo", () => {
    // The root DOES declare `typecheck` — `bun turbo typecheck`, which runs every package in PARALLEL.
    // On a 15.7 GB box with `packages/novaclaw` alone peaking ~3.8 GB that is the documented false
    // wall-clock kill (AGENTS.md pitfall #1). The exclusion is load-bearing, so assert the premise too.
    expect(readManifest(join(ROOT, "package.json")).scripts?.typecheck).toContain("turbo")
    for (const unit of typecheckUnits(ROOT)) {
      expect(unit.dir).not.toBe("")
      expect(unit.dir).not.toBe(".")
      expect(unit.script).not.toContain("turbo")
    }
  })

  test("names every unit uniquely and under one prefix", () => {
    // `--only=` is a SUBSTRING match on the unit name (script/test.ts), so the shared prefix is what
    // makes `bun run test --only=typecheck` mean "just compile the tree", and uniqueness is what keeps
    // `--only=` and the baseline ledgers from addressing the wrong unit.
    const names = typecheckUnits(ROOT).map((unit) => unit.name)
    expect(names.every((name) => name.startsWith(TYPECHECK_PREFIX))).toBe(true)
    expect(new Set(names).size).toBe(names.length)
  })

  test("runs the memory heavyweight last", () => {
    // Measured 2026-07-28, `bun run typecheck` per package: novaclaw 21.4 s and ~3.8 GB against 0.3–6.5 s
    // for everything else — 42% of a ~51 s phase in one unit. Last means a type error anywhere cheap
    // surfaces in seconds, and the one big memory spike happens after everything else has released.
    expect(typecheckUnits(ROOT).at(-1)?.name).toBe(`${TYPECHECK_PREFIX}novaclaw`)
  })

  test("carries each package's own typecheck command rather than assuming one", () => {
    // `app` needs `tsgo -b` and `desktop` needs two passes; the phase shells out to `bun run typecheck`
    // precisely so the package stays the authority. If this list ever collapses to one command, the
    // phase has started guessing.
    const scripts = new Map(typecheckUnits(ROOT).map((unit) => [unit.dir, unit.script]))
    expect(scripts.get("packages/app")).toBe("tsgo -b")
    expect(scripts.get("packages/desktop")).toBe("tsgo -b && tsgo --noEmit -p tsconfig.test.json")
    expect(scripts.get("packages/core")).toBe("tsgo --noEmit")
  })
})

describe("the guard actually bites", () => {
  test("a package that declares a typecheck script becomes a unit", () => {
    const root = fixtureRepo({ "packages/alpha": "tsgo --noEmit" })
    expect(typecheckUnits(root).map((unit) => unit.dir)).toEqual(["packages/alpha"])
  })

  test("a package that declares none does not", () => {
    // Proves the filter is real rather than "every directory becomes a unit" — which would make the
    // completeness assertion above pass no matter what the tree looked like.
    const root = fixtureRepo({ "packages/alpha": "tsgo --noEmit", "packages/beta": null })
    expect(typecheckUnits(root).map((unit) => unit.dir)).toEqual(["packages/alpha"])
  })

  test("a package added after the fact appears without editing any list", () => {
    // The forward guard, stated as the thing it prevents: somebody adds a package, forgets a list, and
    // the gate silently stops covering it. There is no list to forget.
    const root = fixtureRepo({ "packages/alpha": "tsgo --noEmit" })
    mkdirSync(join(root, "packages/gamma"))
    writeFileSync(
      join(root, "packages/gamma/package.json"),
      JSON.stringify({ name: "@fixture/gamma", scripts: { typecheck: "tsgo --noEmit" } }),
    )
    expect(typecheckUnits(root).map((unit) => unit.dir)).toEqual(["packages/alpha", "packages/gamma"])
  })

  test("a directory without a manifest is not mistaken for a package", () => {
    // `packages/*` matches container directories: `packages/sdk` holds only `js`. Reading a package.json
    // that is not there would throw mid-phase instead of skipping.
    const root = fixtureRepo({ "packages/alpha": "tsgo --noEmit" })
    mkdirSync(join(root, "packages/not-a-package"))
    expect(typecheckUnits(root).map((unit) => unit.dir)).toEqual(["packages/alpha"])
  })

  test("an empty typecheck script is not coverage", () => {
    const root = fixtureRepo({ "packages/alpha": "   " })
    expect(typecheckUnits(root)).toEqual([])
  })

  test("a workspace glob it cannot expand is a THROW, not a silent skip", () => {
    // A pattern quietly dropped here is a set of packages quietly untypechecked — the exact failure the
    // discovery exists to make impossible. Fail loudly and name the pattern instead.
    const root = fixtureRepo({ "packages/alpha": "tsgo --noEmit" }, { workspaces: { packages: ["libs/**"] } })
    expect(() => typecheckUnits(root)).toThrow(/unsupported workspace pattern/)
  })

  test("a workspace with no packages at all is a THROW", () => {
    const root = fixtureRepo({}, { workspaces: { packages: [] } })
    expect(() => typecheckUnits(root)).toThrow(/declares no workspace packages/)
  })

  test("two packages whose run-unit names would collide is a THROW", () => {
    // Names are the scope-stripped package name, so `@a/dup` and `@b/dup` are one name. `--only=` and
    // both baseline ledgers key on it, so a collision silently addresses the wrong unit.
    const root = mkdtempSync(join(tmpdir(), "typecheck-units-"))
    fixtures.push(root)
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
    for (const [dir, name] of [
      ["packages/one", "@a/dup"],
      ["packages/two", "@b/dup"],
    ]) {
      mkdirSync(join(root, dir!), { recursive: true })
      writeFileSync(join(root, dir!, "package.json"), JSON.stringify({ name, scripts: { typecheck: "tsgo" } }))
    }
    expect(() => typecheckUnits(root)).toThrow(/resolve to the run-unit name/)
  })

  test("a nameless package that declares a typecheck script is a THROW", () => {
    const root = mkdtempSync(join(tmpdir(), "typecheck-units-"))
    fixtures.push(root)
    writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["packages/*"] } }))
    mkdirSync(join(root, "packages/anon"), { recursive: true })
    writeFileSync(join(root, "packages/anon/package.json"), JSON.stringify({ scripts: { typecheck: "tsgo" } }))
    expect(() => typecheckUnits(root)).toThrow(/no name/)
  })

  test("workspacePackageDirs honours a literal (non-glob) pattern", () => {
    // `packages/sdk/js` is spelled literally in the real root manifest; if literals were dropped, the
    // generated SDK would stop being typechecked and the completeness assertion would still pass.
    const root = fixtureRepo(
      { "packages/alpha": "tsgo --noEmit", "packages/sdk/js": "tsgo --noEmit" },
      {
        workspaces: { packages: ["packages/*", "packages/sdk/js"] },
      },
    )
    expect(workspacePackageDirs(root)).toContain("packages/sdk/js")
    expect(typecheckUnits(root).map((unit) => unit.dir)).toEqual(["packages/alpha", "packages/sdk/js"])
  })
})
