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
// ⚠️ This file used to be proof of the residual hole it could not close: `script/` was not a workspace
// package and had no tsconfig, so nothing typechecked `script/test.ts`, `script/lib/*.ts`, or this test
// — including `typecheck-units.ts`, whose whole purpose is that no package goes untypechecked. CLOSED
// 2026-07-29 (todo/test-speed.md): `script/` is a workspace (`@novaclaw/repo-script`) with its own
// tsconfig, so the SAME manifest-driven discovery covers it. It is pinned by name below, because a
// silently reverted workspace glob would put the harness back outside its own gate and say nothing.

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
    // Guards the guard: an empty walk or a broken glob makes the line above vacuously true.
    // ⚠️ This floor moves DOWN when a package is deliberately deleted, and that is not a weakening — it
    // is why it is a floor and not an equality. Measured 2026-07-29 after the client island
    // (`httpapi-codegen` → `client` → `sdk-next`, 11,046 lines, all three declaring a typecheck script)
    // was deleted under the owner's *discard all the cruft* ruling: **17**, down from 20.
    // Re-measured 2026-07-29 after the supply-chain sweep deleted `packages/effect-sqlite-node` — a dead
    // workspace package with zero importers tree-wide, whose only reference outside its own directory was
    // a dependency edge in `packages/core/package.json`; `core` had long since reimplemented the same
    // Effect SQLite client inline at `src/database/sqlite.node.ts` under its own TypeId. It declared a
    // `typecheck` script, so the count is **16**, down from 17.
    // If this fails saying the count is too LOW, ask whether a package was deleted on purpose before
    // lowering it again — and if it fails because discovery broke, the assertion above fires first.
    expect(expected.size).toBeGreaterThanOrEqual(16)
  })

  test("includes packages/script, which declared no typecheck script until 2026-07-28", () => {
    // The specific hole this change closed, named so a silent removal reads as itself. `@novaclaw/script`
    // is a real workspace package (`src/index.ts`); it is NOT the repo-root `script/` build-tooling
    // directory that the `script` TEST unit covers. Two different things, one word.
    expect(typecheckUnits(ROOT).map((unit) => unit.dir)).toContain("packages/script")
  })

  test("includes the repo-root script/ — the harness that runs this very gate", () => {
    // The other half of that word. Until 2026-07-29 `script/` was not a workspace and had no tsconfig,
    // so `script/test.ts`, `script/lib/*.ts` and THIS FILE were compiled by nothing while their tests
    // ran green — bun type-strips. todo.md ruling 1: the invariant "the tree compiles" did not exist
    // for the directory that enforces it. It is a workspace now, so the same discovery covers it.
    //
    // Pinned by name rather than left to the completeness assertion above, because dropping the one
    // workspace glob would make BOTH agree that `script/` is not a package — the completeness test
    // compares discovery against the same manifest, so it cannot see a manifest that stopped naming it.
    const units = typecheckUnits(ROOT)
    expect(units.map((unit) => unit.dir)).toContain("script")
    // The name must stay distinct from `packages/script`'s `typecheck:script` or discovery THROWS on
    // the run-unit collision — see the ⚠️ in typecheck-units.ts.
    expect(units.find((unit) => unit.dir === "script")?.name).toBe(`${TYPECHECK_PREFIX}repo-script`)
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
