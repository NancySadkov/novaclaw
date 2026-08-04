import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

/**
 * Shrink-only dependency ledger for the three RENDERER packages (`app`, `ui`, `session-ui`).
 *
 * The 2026-07-29 supply-chain sweep removed 39 manifest entries that had zero consumers. This test
 * exists so they cannot come back unnoticed, and so the handful of entries that legitimately have
 * zero imports are a *documented choice* rather than the next sweep's false positive.
 *
 * ⚠️ A naive name-grep lies six different ways, and every one of them has a live instance in this
 * tree. The scanner below therefore understands all six:
 *   1. `import type` (erased at compile time — still a real declaration need)
 *   2. dynamic `import()`
 *   3. query-suffixed specifiers (`?worker`, `?worker&url`, `?raw`, `?url`, `?inline`)
 *   4. bare *directory* specifiers that resolve to `index.ts`, and `exports`-map subpaths
 *   5. CSS `@import` — invisible to every typecheck, and a hard `vite build` break when dangling
 *   6. `tsconfig` `extends` / `types` — what keeps `@types/bun`, `vite` and `@tsconfig/*` alive
 * plus the `@types/x`-is-imported-as-bare-`x` trap.
 *
 * The two ledgers below may only SHRINK. A stale entry fails just as loudly as a missing one, so
 * neither can rot into a rubber stamp.
 */

const PACKAGES_DIR = resolve(import.meta.dir, "..", "..")
const RENDERER_PACKAGES = ["app", "ui", "session-ui"] as const

/**
 * Declared, zero imports, KEPT ON PURPOSE. Every entry needs a reason that says what would break.
 * Deleting the dependency means deleting its line here too — a stale line is a failure.
 */
const KEPT_WITHOUT_IMPORTS: Record<string, Record<string, string>> = {
  app: {
    typescript: "toolchain binary (tsc), never imported",
    "@typescript/native-preview": "toolchain binary (tsgo) — this package's `typecheck` script",
    tailwindcss:
      'zero imports and probably redundant (@tailwindcss/vite pins tailwindcss@4.1.11 itself, and the only CSS `@import "tailwindcss/*"` lives in packages/ui). NOT removed: unprovable without a real `vite build`. Verify, then delete this line and the dependency.',
  },
  ui: {
    typescript: "toolchain binary (tsc) — this package's `build` script",
    "@typescript/native-preview": "toolchain binary (tsgo) — this package's `typecheck` script",
    "motion-utils":
      "zero DIRECT imports, but this top-level pin is what resolves motion-dom's `^12.29.2` to 12.29.2. Drop it and the transitive floats to the newest 12.x.",
  },
  "session-ui": {
    typescript: "toolchain binary, never imported",
    "@typescript/native-preview": "toolchain binary (tsgo) — this package's `typecheck` script",
  },
}

/**
 * Imported but NOT declared — resolves today only by accident. Known gaps, pinned by name so a NEW
 * one fails immediately. Fixing one means deleting its line.
 */
const KNOWN_UNDECLARED: Record<string, string[]> = {
  // UN-PINNED 2026-07-30: `@pierre/diffs` was the one entry here — `src/custom-elements.d.ts`
  // imported it undeclared, invisible because `skipLibCheck: true` suppresses TS2307 inside a
  // `.d.ts`. It is now DECLARED (app `933724da9`), so the ledger must shrink: this is a ratchet,
  // not a suppression list, and an entry that starts passing fails the run until it is removed.
  app: [],
  ui: [],
  "session-ui": [],
}

const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "out",
  ".ts-dist",
  ".turbo",
  ".git",
  "playwright-report",
  "test-results",
])
const SOURCE_EXT = /\.(?:m|c)?[jt]sx?$|\.css$/

// Node builtins that appear WITHOUT the `node:` prefix. Never a manifest entry.
const NODE_BUILTINS = new Set([
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "http",
  "https",
  "module",
  "os",
  "path",
  "process",
  "stream",
  "url",
  "util",
  "worker_threads",
  "zlib",
])

/**
 * Anchored to line start on purpose: `packages/session-ui/src/components/session-diff.test.ts`
 * embeds `import { and } from "drizzle-orm"` inside a single-line diff FIXTURE string, and an
 * unanchored pattern reads that as a real undeclared dependency.
 */
const SPECIFIER_PATTERNS: RegExp[] = [
  /^[ \t]*(?:import|export)\s+(?:type\s+)?[^'";]*?from\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /@import\s+(?:url\()?["']([^"']+)["']/g,
  /<reference\s+types\s*=\s*["']([^"']+)["']/g,
]

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/")) return undefined
  const bare = specifier.split("?")[0]!
  if (bare.startsWith("node:") || bare.startsWith("bun:")) return undefined
  const parts = bare.split("/")
  if (bare.startsWith("@")) return parts.length < 2 ? undefined : `${parts[0]}/${parts[1]}`
  return parts[0]
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

/** `//` also matches `://` inside a URL — the negative lookbehind is load-bearing. */
function parseJsonc(text: string): any {
  return JSON.parse(
    text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<!:)\/\/[^\n]*/g, "")
      .replace(/,(\s*[}\]])/g, "$1"),
  )
}

type Scan = {
  imported: Set<string>
  /** raw `node:`/bare-builtin usage, for `@types/node` */
  usesNode: boolean
  /** raw `bun:` usage, for `@types/bun` */
  usesBun: boolean
}

function scan(pkg: string): Scan {
  const root = join(PACKAGES_DIR, pkg)
  const imported = new Set<string>()
  let usesNode = false
  let usesBun = false

  for (const file of walk(root)) {
    const text = readFileSync(file, "utf8")
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1]!
        if (specifier.startsWith("node:")) usesNode = true
        if (specifier.startsWith("bun:")) usesBun = true
        const name = packageNameOf(specifier)
        if (!name) continue
        if (NODE_BUILTINS.has(name)) {
          usesNode = true
          continue
        }
        if (name === "bun") {
          usesBun = true
          continue
        }
        imported.add(name)
      }
    }
  }

  // tsconfig `extends` and `types` keep packages alive with zero imports (audit traps #2 and #3).
  for (const entry of readdirSync(root)) {
    if (!/^tsconfig.*\.json$/.test(entry)) continue
    const config = parseJsonc(readFileSync(join(root, entry), "utf8"))
    const extendsField: string[] = ([] as string[]).concat(config.extends ?? [])
    for (const value of extendsField) {
      const name = packageNameOf(value)
      if (name) imported.add(name)
    }
    for (const value of config.compilerOptions?.types ?? []) {
      if (value === "bun") usesBun = true
      else if (value === "node") usesNode = true
      else {
        const name = packageNameOf(value)
        if (name) imported.add(name)
      }
    }
  }

  return { imported, usesNode, usesBun }
}

/** `@types/foo` is imported as bare `foo`; `@types/scope__pkg` as `@scope/pkg`. */
function typesTargetOf(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined
  const tail = name.slice("@types/".length)
  return tail.includes("__") ? `@${tail.replace("__", "/")}` : tail
}

describe("renderer dependency ledger", () => {
  for (const pkg of RENDERER_PACKAGES) {
    const manifestPath = join(PACKAGES_DIR, pkg, "package.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
    const declared: Record<string, string> = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    }
    const result = scan(pkg)

    const isSatisfied = (name: string) => {
      if (result.imported.has(name)) return true
      if (name === "@types/bun") return result.usesBun
      if (name === "@types/node") return result.usesNode
      const target = typesTargetOf(name)
      return target ? result.imported.has(target) : false
    }

    test(`${pkg}: every declared dependency is imported, or ledgered with a reason`, () => {
      const ledger = KEPT_WITHOUT_IMPORTS[pkg] ?? {}
      const unexplained = Object.keys(declared)
        .filter((name) => !isSatisfied(name))
        .filter((name) => !(name in ledger))
        .sort()
      expect(unexplained).toEqual([])
    })

    test(`${pkg}: the kept-without-imports ledger has no stale entries`, () => {
      const ledger = KEPT_WITHOUT_IMPORTS[pkg] ?? {}
      const stale = Object.keys(ledger)
        .filter((name) => !(name in declared) || isSatisfied(name))
        .sort()
      expect(stale).toEqual([])
      for (const [name, reason] of Object.entries(ledger)) {
        expect(reason.length, `${pkg} → ${name} needs a real reason`).toBeGreaterThan(20)
      }
    })

    test(`${pkg}: nothing is imported that the package does not declare`, () => {
      const own: string = manifest.name
      const undeclared = [...result.imported]
        .filter((name) => !(name in declared))
        .filter((name) => name !== own)
        .sort()
      expect(undeclared).toEqual([...(KNOWN_UNDECLARED[pkg] ?? [])].sort())
    })
  }

  /**
   * Both of these SHIP through a CSS `@import` that no typecheck can see, so `devDependencies` was
   * the wrong section — it resolved only because workspace devDeps happen to be installed.
   */
  test("dependencies that ship via CSS are in `dependencies`, not `devDependencies`", () => {
    const shipped = [
      { pkg: "ui", name: "tailwindcss", via: "src/styles/tailwind/index.css (in `files` + `exports`)" },
      { pkg: "app", name: "tw-animate-css", via: "src/index.css (an `exports` entry)" },
    ]
    for (const { pkg, name, via } of shipped) {
      const manifest = JSON.parse(readFileSync(join(PACKAGES_DIR, pkg, "package.json"), "utf8"))
      expect(manifest.dependencies?.[name], `${pkg} → ${name} ships via ${via}`).toBeDefined()
      expect(manifest.devDependencies?.[name], `${pkg} → ${name} must not be a devDependency`).toBeUndefined()
    }
  })

  /**
   * `packages/app` carries TWO drag-and-drop libraries and BOTH are live: `@dnd-kit/*` drives the
   * titlebar tab strip, `@thisbeyond/solid-dnd` the session/terminal panels and the home screen.
   * That is a real consolidation task, not dead code — this test fails if either side goes quiet,
   * which is the moment the survivor should absorb the other.
   */
  test("both drag-and-drop libraries in `app` still have importers", () => {
    const result = scan("app")
    expect(result.imported.has("@dnd-kit/solid")).toBe(true)
    expect(result.imported.has("@thisbeyond/solid-dnd")).toBe(true)
  })
})
