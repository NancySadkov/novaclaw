/**
 * Which workspace packages `bun run test` typechecks — DISCOVERED from the workspace, never listed.
 *
 * ─── why the gate needs this at all ────────────────────────────────────────────────────────────────
 * Bun type-STRIPS: it deletes type annotations without checking them. So a test file can pass every
 * assertion it makes while failing `tsgo` outright. Measured 2026-07-28: `bun run test` reported
 * **21/21 run units green** with two uncompilable files in the tree — a `readonly string[]` handed to
 * `toEqual` (TS4104) and a `Layer<unknown, unknown, never>` parameter that is not bivariant. Both were
 * found by a human running typechecks by hand, package by package, and remembering to.
 *
 * todo.md ruling 1: *every invariant whose violation compiles green ships in the same commit as a
 * mechanical check — a test or a type — or the invariant does not exist.* "The tree compiles" was
 * exactly such an invariant, enforced by nothing but an agent's memory. `script/test.ts` runs these
 * units now, so it is enforced by the gate.
 *
 * ─── why DISCOVERED rather than hand-listed ────────────────────────────────────────────────────────
 * A hand-maintained list has one failure mode — somebody adds a package and forgets the list — and it
 * is SILENT: the new package is simply never typechecked and the summary still says green. That is the
 * "reads as coverage while being none" hole `script/test.ts` exists to remove, reintroduced one level
 * up. Reading the workspace makes the omission impossible instead of merely detectable.
 *
 * `typecheck-units.test.ts` pins that the discovery still sees the real tree and is negative-controlled
 * so it cannot pass vacuously.
 *
 * ⚠️ The repo ROOT is deliberately not a unit even though `package.json` has a `typecheck` script: it is
 * `bun turbo typecheck`, which fans every package out in PARALLEL. On a 15.7 GB box that is the
 * documented path to a false wall-clock kill — `packages/novaclaw` alone peaks ~3.8 GB (AGENTS.md
 * pitfall #1). The gate runs one package at a time, in-process order, on purpose.
 *
 * ─── the hole THIS module used to sit inside (closed 2026-07-29) ───────────────────────────────────
 * Discovery is manifest-driven, so for a year the repo-root `script/` directory — `test.ts`, the whole
 * harness that runs the gate, and this file, whose entire job is *"no package goes untypechecked"* —
 * was typechecked by nothing at all. It was not a workspace, it had no tsconfig, and the root tsconfig
 * has no `include`, so `tsgo` had never compiled a line of it. Its TESTS ran (`script/test.ts`
 * registers a `script` unit) and bun type-STRIPS, so every assertion could pass while `tsgo` failed.
 * The fix is the shape this file already argues for — `script/package.json` + `script/tsconfig.json`
 * plus one workspace glob, so discovery finds it — rather than a hardcoded unit in `test.ts`.
 *
 * ⚠️ **Two different things, one word.** `packages/script` is the `@novaclaw/script` library
 * (`src/index.ts`, the channel resolver's consumer); the repo-root `script/` is the build tooling. They
 * would BOTH resolve to the run-unit name `typecheck:script` and hit the collision throw below, so the
 * root one is named `@novaclaw/repo-script` → `typecheck:repo-script`. Renaming it back is not a
 * cosmetic change; it makes the workspace undiscoverable-by-throw.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

/** Every typecheck run unit is named `typecheck:<package>`, so `--only=typecheck` selects the phase. */
export const TYPECHECK_PREFIX = "typecheck:"

/**
 * Packages whose typecheck is heavy enough to be worth ordering, run LAST.
 *
 * Measured 2026-07-28 on this box, `bun run typecheck` per package: `novaclaw` **21.4 s**, against
 * 0.3–6.5 s for every other package (whole phase ≈ 51 s). It is 42% of the phase on its own and peaks
 * ~3.8 GB. Running it last means a type error anywhere cheap surfaces in seconds rather than after it,
 * and the single big memory spike happens once everything else has already released.
 */
const HEAVYWEIGHTS: ReadonlySet<string> = new Set(["novaclaw"])

export type TypecheckUnit = {
  /** The run-unit name, e.g. `typecheck:core`. */
  readonly name: string
  /** Package directory RELATIVE to the repo root, POSIX-separated — used as the spawn cwd. */
  readonly dir: string
  /** The package's own `typecheck` script. Carried so a failure can name what actually ran. */
  readonly script: string
}

type PackageJson = {
  readonly name?: unknown
  readonly scripts?: Readonly<Record<string, unknown>>
  readonly workspaces?: unknown
}

const readPackageJson = (file: string): PackageJson => JSON.parse(readFileSync(file, "utf8")) as PackageJson

/**
 * The workspace globs from the root `package.json`, in either supported spelling (bun accepts both a
 * bare array and `{ packages: [...] }`; this repo uses the latter).
 */
function workspacePatterns(root: string): string[] {
  const workspaces: unknown = readPackageJson(join(root, "package.json")).workspaces
  const raw = Array.isArray(workspaces)
    ? workspaces
    : typeof workspaces === "object" && workspaces !== null && "packages" in workspaces
      ? workspaces.packages
      : undefined
  if (!Array.isArray(raw) || raw.length === 0)
    throw new Error(`${join(root, "package.json")} declares no workspace packages — cannot discover typecheck units`)
  return raw.map(String)
}

/**
 * Expand the workspace globs to package directories.
 *
 * Only the two shapes this repo uses are supported — a literal path (`packages/sdk/js`) and a single
 * trailing `/*` (`packages/*`). Anything else THROWS rather than being skipped: a pattern silently
 * dropped here is a package silently untypechecked, which is the whole failure this module exists to
 * make impossible. A `**` glob is a real request to support, not a reason to guess.
 */
export function workspacePackageDirs(root: string): string[] {
  const dirs: string[] = []
  for (const pattern of workspacePatterns(root)) {
    const normalized = pattern.replaceAll("\\", "/").replace(/\/+$/, "")
    if (!normalized.includes("*")) {
      dirs.push(normalized)
      continue
    }
    const parent = normalized.slice(0, -2)
    if (!normalized.endsWith("/*") || parent.includes("*"))
      throw new Error(
        `unsupported workspace pattern ${JSON.stringify(pattern)} — script/lib/typecheck-units.ts understands ` +
          `a literal path or a single trailing "/*". Teach it the new shape rather than leaving those packages ` +
          `out of the typecheck phase.`,
      )
    for (const entry of readdirSync(join(root, parent), { withFileTypes: true }))
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`)
  }
  // `packages/*` matches container directories too (`packages/sdk` holds only `js`); a directory with no
  // manifest is not a package.
  return [...new Set(dirs)].filter((dir) => existsSync(join(root, dir, "package.json"))).sort()
}

/** `@novaclaw/session-ui` -> `session-ui`. The scope carries no information here and doubles the width. */
const shortName = (packageName: string) =>
  packageName.startsWith("@") ? packageName.slice(packageName.indexOf("/") + 1) : packageName

/**
 * Every workspace package that declares a `typecheck` script, as run units, heavyweights last.
 *
 * A package WITHOUT the script is not an error — `packages/script` had none until 2026-07-28 and simply
 * went unchecked. That is why the companion test asserts the discovered set against an independent walk
 * of the tree: the interesting question is not "is the list right" but "did the tree grow a package this
 * never saw".
 *
 * ⚠️ And "package" here means *whatever the root manifest's workspace globs name*, which is why the
 * repo-root `script/` directory could be brought in by declaring it a workspace rather than by teaching
 * this function about a second kind of thing. If a future directory needs typechecking, make it
 * discoverable; do not add a branch here.
 */
export function typecheckUnits(root: string): TypecheckUnit[] {
  const units: TypecheckUnit[] = []
  const seen = new Map<string, string>()
  for (const dir of workspacePackageDirs(root)) {
    const manifest = readPackageJson(join(root, dir, "package.json"))
    const script = manifest.scripts?.typecheck
    if (typeof script !== "string" || script.trim() === "") continue
    if (typeof manifest.name !== "string" || manifest.name.trim() === "")
      throw new Error(`${dir}/package.json declares a typecheck script but no name — cannot name its run unit`)
    const short = shortName(manifest.name)
    const collision = seen.get(short)
    if (collision !== undefined)
      throw new Error(
        `two workspace packages resolve to the run-unit name ${TYPECHECK_PREFIX}${short}: ${collision} and ${dir}. ` +
          `Run-unit names must be unique or --only= and the baseline ledgers address the wrong one.`,
      )
    seen.set(short, dir)
    units.push({ name: `${TYPECHECK_PREFIX}${short}`, dir, script })
  }
  const heavy = (unit: TypecheckUnit) => (HEAVYWEIGHTS.has(unit.name.slice(TYPECHECK_PREFIX.length)) ? 1 : 0)
  return units.sort((a, b) => heavy(a) - heavy(b) || a.name.localeCompare(b.name))
}
