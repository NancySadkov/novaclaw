import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * **`@novaclaw/sdk` carries ZERO runtime dependencies**, and this is what makes that sentence true
 * rather than aspirational (todo.md → *Standing architecture decisions*; ruling 1: an invariant
 * whose violation compiles green ships with a mechanical check, or it does not exist).
 *
 * ⚠️ Why it needs a guard. Until 2026-07-29 the package declared exactly one runtime dependency —
 * `cross-spawn`, used by `src/v2/server.ts` to spawn `novaclaw serve` — and `src/v2/index.ts`, the
 * BROWSER-FACING barrel that 24 renderer files import, did `export * from "./server.js"`. So the
 * renderer's import graph contained a process spawner reaching `node:child_process`. Nothing failed:
 * Rollup tree-shook it out of the built bundle, so it was hygiene rather than a shipped hazard, and
 * a hygiene problem that costs nothing today is exactly the kind that survives review. `server.ts`
 * and its `process.ts` helper are deleted; launching an instance is a harness concern that
 * `packages/novaclaw`'s `serve` command and the desktop's `spawnLocalServer` already own.
 *
 * The two properties below are DIFFERENT and neither implies the other:
 *
 *   1. the MANIFEST declares nothing that installs at a consumer's runtime — what an installer sees;
 *   2. the SOURCE GRAPH imports nothing this package does not own — what a bundler sees.
 *
 * (1) alone would pass again the moment someone imports a node builtin (never a package.json entry
 * at all) or leans on a workspace-hoisted module it never declared. (2) alone would pass while the
 * manifest still shipped a dependency nothing imports. The regression this file exists to prevent
 * was visible to (2) and invisible to (1): `node:child_process`, not `cross-spawn`, is what made the
 * barrel unusable in a browser.
 *
 * What this file cannot see is whether the generated client still WORKS — that is
 * `test/generated-drift.test.ts`, which checks it against the spec it is generated from.
 */

/** `packages/sdk/js` — `test/` → the package root. */
const PKG = path.resolve(import.meta.dir, "..")
const SRC = path.join(PKG, "src")

interface Manifest {
  readonly exports?: Record<string, string>
  readonly [key: string]: unknown
}

const manifest = JSON.parse(fs.readFileSync(path.join(PKG, "package.json"), "utf8")) as Manifest

/**
 * Every manifest field that installs code into a consumer's runtime. `devDependencies` is
 * deliberately absent: the emitter, tsc and the type packages are build-time and never reach a
 * consumer — `files` ships `dist` only.
 */
const RUNTIME_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const

interface Source {
  /** Package-relative, posix-separated — the name the failures speak. */
  readonly name: string
  /** CODE ONLY. Comments are stripped, so a file that merely *discusses* `cross-spawn` is clean. */
  readonly text: string
}

/** The comment stripper the kill-tree ledger uses — `//` must not eat the `//` in a URL. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")

function collect(dir: string, out: Source[]): Source[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collect(full, out)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue
    out.push({
      name: path.relative(PKG, full).replaceAll("\\", "/"),
      text: stripComments(fs.readFileSync(full, "utf8")),
    })
  }
  return out
}

const sources = collect(SRC, [])

/**
 * Every module specifier a file names, by MECHANISM rather than by keyword: static `from "…"`
 * (import, `export … from`, `export * from`), a bare side-effect `import "…"`, a dynamic
 * `import("…")` and `require("…")`. A specifier reachable by any of those is in the graph.
 *
 * ⚠️ Two things here are not decoration, and both were found by running this against the real tree:
 *   · `from` must NOT be preceded by a quote. `sdk.gen.ts:3036` contains `{ in: "body", key: "from" }`
 *     — a request-parameter descriptor for an API query field that happens to be named `from`. The
 *     closing quote of that string reads as the opening quote of a specifier, and the guard reported
 *     the generated client as importing a foreign module. A guard that cries wolf on the code it
 *     ships with gets deleted, so it is pinned as a negative control below.
 *   · a specifier may not contain a NEWLINE. That is what bounded the damage above to something
 *     visible instead of something plausible.
 */
function specifiersIn(text: string): string[] {
  const found = new Set<string>()
  for (const re of [
    /(?:^|[^\w$"'`])from\s*["']([^"'\n]+)["']/gm,
    /(?:^|[\s;{}()])import\s*["']([^"'\n]+)["']/gm,
    /\bimport\s*\(\s*["']([^"'\n]+)["']/g,
    /\brequire\s*\(\s*["']([^"'\n]+)["']/g,
  ])
    for (const match of text.matchAll(re)) found.add(match[1]!)
  return [...found]
}

/** A specifier this package owns: a path into its own source tree. Everything else is foreign. */
const isOwn = (specifier: string): boolean => specifier.startsWith("./") || specifier.startsWith("../")

/**
 * Resolve a relative specifier the way `moduleResolution: nodenext` does for a TS source tree: the
 * emitted `./client.js` is authored as `./client.ts`. Returns the package-relative name, or
 * undefined if nothing on disk answers — which is itself a failure worth reporting.
 */
function resolve(fromFile: string, specifier: string): string | undefined {
  const base = path.resolve(PKG, path.dirname(fromFile), specifier)
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts"), base])
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile())
      return path.relative(PKG, candidate).replaceAll("\\", "/")
  return undefined
}

/** The transitive closure of `src/v2/index.ts` — the graph a renderer actually pulls in. */
function walkFromBarrel(): { reached: Set<string>; unresolved: string[]; foreign: string[] } {
  const byName = new Map(sources.map((file) => [file.name, file]))
  const reached = new Set<string>()
  const unresolved: string[] = []
  const foreign: string[] = []
  const queue = ["src/v2/index.ts"]
  while (queue.length > 0) {
    const name = queue.pop()!
    if (reached.has(name)) continue
    reached.add(name)
    const file = byName.get(name)
    if (file === undefined) {
      unresolved.push(`${name} (reached but not in the sweep)`)
      continue
    }
    for (const specifier of specifiersIn(file.text)) {
      if (!isOwn(specifier)) {
        foreign.push(`${name} → ${specifier}`)
        continue
      }
      const target = resolve(name, specifier)
      if (target === undefined) unresolved.push(`${name} → ${specifier} (resolves to nothing on disk)`)
      else queue.push(target)
    }
  }
  return { reached, unresolved, foreign: foreign.sort() }
}

describe("the sweep", () => {
  test("actually has the package to look at", () => {
    // A moved test file or a bad root would silently empty the sweep and turn every assertion below
    // into a tautology. 18 files on 2026-07-29 (3 hand-written + 15 under src/v2/gen).
    expect(sources.length).toBeGreaterThanOrEqual(15)
    expect(sources.map((file) => file.name)).toContain("src/v2/index.ts")
  })
})

describe("the manifest declares no runtime dependency", () => {
  test("dependencies, peerDependencies and optionalDependencies are all empty", () => {
    const declared: string[] = []
    for (const field of RUNTIME_FIELDS)
      for (const name of Object.keys((manifest[field] as Record<string, string> | undefined) ?? {}))
        declared.push(`${field}.${name}`)
    expect(
      declared,
      [
        "packages/sdk/js declared a runtime dependency.",
        "The standing decision (todo.md) is that `@novaclaw/sdk` carries ZERO of them: it is imported by",
        "the renderer, and a browser-facing package that needs an npm install is not one.",
        "If the code genuinely needs a host capability, it belongs in packages/novaclaw or the desktop",
        "main process, not here — that is why `src/v2/server.ts` was deleted.",
      ].join("\n"),
    ).toEqual([])
  })

  test("every exports subpath resolves to a file that exists", () => {
    // The dangling-entry class, found live: removing `src/v2/server.ts` while leaving
    // `"./v2/server"` in the map is a runtime failure that no typecheck and no bundler sees, because
    // nothing in this repo imports that subpath.
    const dangling = Object.entries(manifest.exports ?? {})
      .filter(([, target]) => !fs.existsSync(path.resolve(PKG, target)))
      .map(([subpath, target]) => `${subpath} → ${target}`)
    expect(dangling).toEqual([])
    expect(Object.keys(manifest.exports ?? {}).length).toBeGreaterThan(0)
  })
})

describe("the source graph imports nothing this package does not own", () => {
  test("no file under src/ names a foreign specifier", () => {
    const offenders = sources
      .flatMap((file) =>
        specifiersIn(file.text)
          .filter((specifier) => !isOwn(specifier))
          .map((specifier) => `${file.name} → ${specifier}`),
      )
      .sort()
    expect(
      offenders,
      [
        "A file under packages/sdk/js/src imports something outside the package.",
        "Both kinds are the same defect here: an npm package makes the manifest lie, and a `node:`",
        "builtin makes the barrel unusable in a browser without the manifest changing at all.",
        "This is the check the package.json assertion above CANNOT make.",
      ].join("\n"),
    ).toEqual([])
  })

  test("the browser-facing barrel's transitive graph is closed, and reaches the whole package", () => {
    const { reached, unresolved, foreign } = walkFromBarrel()
    expect(foreign, "src/v2/index.ts transitively imports a foreign module").toEqual([])
    expect(unresolved, "a specifier in the barrel's graph points at nothing on disk").toEqual([])
    // Guards the guard twice over: a walk that resolved nothing would report an empty `foreign` too,
    // and the vendored @hey-api fetch/SSE runtime is the single strongest evidence that the typed
    // client is dependency-free rather than delegating the transport to a package.
    expect(reached.size).toBeGreaterThanOrEqual(15)
    expect([...reached]).toContain("src/v2/gen/core/serverSentEvents.gen.ts")
    // No orphans: every shipped source file is on the barrel's graph. This is how a node-only file
    // survives a deletion — `src/process.ts` was reachable only from `src/v2/server.ts`, so once the
    // spawner went it would have sat in `dist` forever, imported by nobody and swept by nothing.
    const orphans = sources.map((file) => file.name).filter((name) => !reached.has(name))
    expect(orphans, "unreferenced file(s) under src/ — delete them or wire them in").toEqual([])
  })
})

describe("the guard actually bites (negative control)", () => {
  test("the foreign-specifier predicate classifies the real regression", () => {
    // Verbatim, the two specifiers this package carried until 2026-07-29.
    expect(isOwn("cross-spawn")).toBe(false)
    expect(isOwn("node:child_process")).toBe(false)
    // A builtin WITHOUT the `node:` prefix is the sneakier spelling, and it is equally foreign.
    expect(isOwn("fs")).toBe(false)
    expect(isOwn("@novaclaw/core")).toBe(false)
    // …and the shapes the generated tree actually uses must stay silent, or every file offends.
    expect(isOwn("./client.js")).toBe(true)
    expect(isOwn("../error-interceptor.js")).toBe(true)
    expect(isOwn("./gen/client/client.gen.js")).toBe(true)
  })

  test("the extractor sees every mechanism, not just `import … from`", () => {
    expect(specifiersIn(`import launch from "cross-spawn"`)).toEqual(["cross-spawn"])
    expect(specifiersIn(`export * from "./server.js"`)).toEqual(["./server.js"])
    expect(specifiersIn(`export { stop } from "../process.js"`)).toEqual(["../process.js"])
    expect(specifiersIn(`import "cross-spawn"`)).toEqual(["cross-spawn"])
    expect(specifiersIn(`const m = await import("node:child_process")`)).toEqual(["node:child_process"])
    expect(specifiersIn(`const { spawn } = require("cross-spawn")`)).toEqual(["cross-spawn"])
    // Comments are stripped before extraction, so prose about the deleted spawner is not an offence.
    expect(specifiersIn(stripComments(`// it used to import launch from "cross-spawn"\nconst x = 1`))).toEqual([])
    // …and the shape that made the first draft of this guard fail on its own generated client,
    // verbatim from src/v2/gen/sdk.gen.ts:3036. An API query parameter named `from`, not an import.
    expect(specifiersIn(`{ in: "body", key: "from" },\n            { in: "query", key: "limit" },`)).toEqual([])
  })

  test("the offender sweep can report a non-empty list", () => {
    // The real sweep asserts an EMPTY array, which alone cannot show a non-empty one is reachable.
    const synthetic: Source = { name: "src/rogue.ts", text: `import launch from "cross-spawn"` }
    const offenders = [synthetic]
      .flatMap((file) =>
        specifiersIn(file.text)
          .filter((specifier) => !isOwn(specifier))
          .map((specifier) => `${file.name} → ${specifier}`),
      )
      .sort()
    expect(offenders).toEqual(["src/rogue.ts → cross-spawn"])
  })

  test("resolution answers undefined for a specifier that points at nothing", () => {
    expect(resolve("src/v2/index.ts", "./client.js")).toBe("src/v2/client.ts")
    // The file this unit deleted: proof the walk would have reported it rather than skipping it.
    expect(resolve("src/v2/index.ts", "./server.js")).toBeUndefined()
    expect(resolve("src/v2/client.ts", "../process.js")).toBeUndefined()
  })
})
