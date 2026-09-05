import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { parseJSONC } from "./utils/jsonc"

/**
 * Shrink-only dependency ledger for EVERY workspace package.
 *
 * The 2026-07-29 supply-chain sweep removed 39 manifest entries that had zero consumers. This test
 * exists so they cannot come back unnoticed, and so the handful of entries that legitimately have
 * zero imports are a *documented choice* rather than the next sweep's false positive.
 *
 * It covered the three RENDERER packages (`app`, `ui`, `session-ui`) until 2026-09-03, when the
 * refactor sweep's third-party ledger closed on a desktop `marked@15` whose only importer had been
 * deleted two days earlier — and the sibling sweep found four more declarations of the same shape in
 * `packages/novaclaw`, all of which had lost their importers in earlier commits. A manifest asserting
 * a dependency nothing in its package reaches is the class; this file is the ratchet, and a ratchet
 * over 3 of 17 packages is a ratchet with a hole in it. The file keeps its name so the citations to
 * it stay valid.
 *
 * ⚠️ A naive name-grep lies seven different ways, and every one of them has a live instance in this
 * tree. The scanner below therefore understands all seven:
 *   1. `import type` (erased at compile time — still a real declaration need)
 *   2. dynamic `import()`
 *   3. query-suffixed specifiers (`?worker`, `?worker&url`, `?raw`, `?url`, `?inline`)
 *   4. bare *directory* specifiers that resolve to `index.ts`, and `exports`-map subpaths
 *   5. CSS `@import` — invisible to every typecheck, and a hard `vite build` break when dangling
 *   6. `tsconfig` `extends` / `types` — what keeps `@types/bun`, `vite` and `@tsconfig/*` alive
 *   7. a binary invoked from a `package.json` script — what keeps `@typescript/native-preview`
 *      (`tsgo`), `electron-vite`, `electron-builder` and `drizzle-kit` alive with zero imports
 * plus the `@types/x`-is-imported-as-bare-`x` trap, in both directions.
 *
 * The ledgers below may only SHRINK. A stale entry fails just as loudly as a missing one, so
 * neither can rot into a rubber stamp.
 */

const PACKAGES_DIR = resolve(import.meta.dir, "..", "..")
const REPO_ROOT = resolve(PACKAGES_DIR, "..")

/**
 * Every directory under `packages/` that carries a manifest, keyed by the short name the ledgers
 * use. `sdk` is the one whose manifest sits a level down.
 */
function workspacePackages(): Record<string, string> {
  const found: Record<string, string> = {}
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const dir = join(PACKAGES_DIR, entry)
    if (!statSync(dir).isDirectory()) continue
    if (existsSync(join(dir, "package.json"))) found[entry] = dir
    else if (existsSync(join(dir, "js", "package.json"))) found[entry] = join(dir, "js")
  }
  return found
}

/**
 * Declared, zero imports, KEPT ON PURPOSE. Every entry needs a reason that says what would break.
 * Deleting the dependency means deleting its line here too — a stale line is a failure.
 */
const KEPT_WITHOUT_IMPORTS: Record<string, Record<string, string>> = {
  app: {
    tailwindcss:
      'zero imports and probably redundant (@tailwindcss/vite pins tailwindcss@4.1.11 itself, and the only CSS `@import "tailwindcss/*"` lives in packages/ui). NOT removed: unprovable without a real `vite build`. Verify, then delete this line and the dependency.',
  },
  ui: {
    "motion-utils":
      "zero DIRECT imports, but this top-level pin is what resolves motion-dom's `^12.29.2` to 12.29.2. Drop it and the transitive floats to the newest 12.x.",
  },
  desktop: {
    "jsonc-parser":
      "zero imports in this package, but `packages/novaclaw/script/build-node.ts` leaves it EXTERNAL in the sidecar bundle (its Node entry is UMD and cannot be inlined), and the desktop copies those chunks into `out/main/chunks`. The packaged app resolves it from THIS manifest's node_modules; drop it and the sidecar dies at load in the packaged app only.",
    "@ladybugdb/wasm-core":
      "the KB graph engine, loaded by the sidecar through a RUNTIME `createRequire(...)('@ladybugdb/wasm-core/nodejs/sync')` that no bundler can see (`electron-builder.config.ts`, beside `asarUnpack`). It has to ship as a real package that Node resolution can find.",
  },
  novaclaw: {
    "@ff-labs/fff-bun":
      "never imported: `script/build.ts` reads THIS manifest's version to `bun install --os=* --cpu=*` every platform's `fff` binary before compiling the CLI. The declaration is the build's version source.",
  },
}

/**
 * Kept in every package that declares them, for one reason each. Checked for staleness only where
 * the package actually declares the entry, since a shared reason cannot be stale per package.
 */
const KEPT_EVERYWHERE: Record<string, string> = {
  typescript:
    "the TypeScript language service. Where nothing imports it and no script runs `tsc` (typechecking goes through `script/tsgo.ts` → @typescript/native-preview) it is NOT verified removable; it is kept as the `typescript` peer that editors and vite/electron-vite resolve from the nearest manifest. Prove one package builds and typechecks without it, then delete it there.",
  "@typescript/native-preview":
    "toolchain binary (tsgo) behind every package's `typecheck` script. The script is the shared `script/tsgo.ts`, which resolves the binary from the ROOT node_modules — so the per-package pin is the convention that keeps each manifest honest about its own toolchain, not a resolution need. Kept on purpose; do not add a per-package reason.",
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
  // 2026-09-03, on extending the ledger to the whole tree: core's `plugin/variant.ts` imported the
  // sdk's generated types and `script/migration.ts` dynamic-imported `prettier`, both resolving
  // only through workspace hoisting. Both are now DECLARED in core, so nothing is pinned here.
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
  // native and cargo build output: `packages/host/build`, `packages/dht/target`
  "build",
  "target",
])
const SOURCE_EXT = /\.(?:m|c)?[jt]sx?$|\.css$/

// Node builtins that appear WITHOUT the `node:` prefix. Never a manifest entry.
const NODE_BUILTINS = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "events",
  "fs",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "perf_hooks",
  "process",
  "querystring",
  "readline",
  "repl",
  "stream",
  "string_decoder",
  "timers",
  "tls",
  "tty",
  "url",
  "util",
  "v8",
  "vm",
  "worker_threads",
  "zlib",
])

/**
 * Anchored to line start on purpose: `packages/session-ui/src/components/session-diff.test.ts`
 * embeds `import { and } from "drizzle-orm"` inside a single-line diff FIXTURE string, and an
 * unanchored pattern reads that as a real undeclared dependency.
 */
const SPECIFIER_PATTERNS: RegExp[] = [
  // ⚠️ The `import` and `export` arms are SEPARATE, and the export one requires `*` or `{`. The char
  // class deliberately spans newlines so a multi-line import list still reaches its `from` — which
  // also means a lone `export const foo = (input: {` swallows everything until the next `from "…"`
  // ANYWHERE below it, comments included. Measured 2026-08-21: a sentence reading `a blank title is
  // a different fact from "no title"` was counted as an import of the package `no title`, forty
  // lines below the `export const` that started the match. Fifth instance of the "writing ABOUT a
  // pattern trips the guard against it" trap this file already names four times — and the first
  // where the prose was innocent English rather than a quoted specifier. `export … from` is only
  // legal as a RE-EXPORT, so requiring `*` or `{` costs nothing and closes it.
  /^[ \t]*import\s+(?:type\s+)?[^'";]*?from\s*["']([^"']+)["']/gm,
  /^[ \t]*export\s+(?:type\s+)?(?:\*|\{)[^'";]*?from\s*["']([^"']+)["']/gm,
  /^[ \t]*import\s*["']([^"']+)["']/gm,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  // ⚠️ `require` must not be a METHOD. `packages/novaclaw/test/skill/skill.test.ts` calls
  // `skill.require("missing-skill")`, and an unguarded `\brequire\s*\(` read that as a CommonJS
  // require of a package called `missing-skill`. Sixth instance of "writing ABOUT (or near) a
  // pattern trips the guard against it": the word is the same, the syntax is not.
  /(?<![.\w$])require\s*\(\s*["']([^"']+)["']\s*\)/g,
  // ⚠️ ANCHORED to the start of a line, and that anchor is load-bearing. Unanchored, this pattern
  // matched `@import "tailwindcss/*"` written inside a LEDGER REASON in this very file — so the
  // entry explaining why tailwindcss has no imports was itself counted as an import of it, and the
  // stale-entry test then failed on prose rather than on anything that had moved. Fourth instance of
  // AGENTS.md's "writing ABOUT a pattern trips the guard against it"; the cure there is the same one
  // used by the two patterns above — anchor to a real line, since a CSS `@import` opens its line
  // (the spec requires it to precede other rules) while a mention inside a sentence never does.
  /^[ 	]*@import\s+(?:url\()?["']([^"']+)["']/gm,
  /<reference\s+types\s*=\s*["']([^"']+)["']/g,
]

/**
 * Comment lines are dropped before scanning. The dynamic-import pattern cannot be line-anchored (a
 * `import("x")` legitimately sits mid-expression), so it was the one arm still open to prose:
 * `packages/desktop/electron.vite.config.ts` explains in a comment WHY `import("audio-decode")` is
 * externalized, and that sentence was counted as the desktop importing `audio-decode`. Seventh
 * instance of the trap. A line whose first token is `//`, `*` or `/*` is never code.
 */
function stripCommentLines(text: string): string {
  return text.replace(/^[ \t]*(?:\/\/|\/\*|\*).*$/gm, "")
}

function packageNameOf(specifier: string): string | undefined {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("@/")) return undefined
  // `#sqlite`, `#pty`, `#fff`: the package's own `imports` map (core). A self-reference, never a manifest entry.
  if (specifier.startsWith("#")) return undefined
  const bare = specifier.split("?")[0]!
  if (bare.startsWith("node:") || bare.startsWith("bun:")) return undefined
  // A bare specifier carrying a TypeScript extension is a VIRTUAL module the bundler supplies
  // (`novaclaw-web-ui.gen.ts`, see `build-node.ts`'s `files`), never a package. ⚠️ `.ts` only: a
  // `.js` tail is ordinary — `decimal.js` and `@zip.js/zip.js` are package NAMES, and every
  // `@modelcontextprotocol/sdk/client/index.js` subpath ends that way. Measured 2026-09-03: a
  // `[jt]s` rule here hid all three and reported the packages as declared-but-unimported.
  if (/\.(?:m|c)?tsx?$/.test(bare)) return undefined
  const parts = bare.split("/")
  if (bare.startsWith("@")) return parts.length < 2 ? undefined : `${parts[0]}/${parts[1]}`
  return parts[0]
}

/**
 * Guard tests that SPELL the shapes they guard against are the trap's eighth and ninth instances,
 * and are not scanned. This file's fixture below writes `require("phantom-block")` and
 * `import("audio-decode")` in code, so scanning it reports both as `app` imports; the sdk's
 * `zero-runtime-dependencies.test.ts` does the same with `require("cross-spawn")` inside a template
 * string on line 248, and there is no anchor that separates a fixture from the thing it imitates.
 * Neither file imports anything but `bun:test`, `node:*` and a sibling utility.
 */
const SKIP_FILES = new Set(["renderer-dependency-ledger.test.ts", "zero-runtime-dependencies.test.ts"])

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (SOURCE_EXT.test(entry)) out.push(full)
  }
  return out
}

type Scan = {
  imported: Set<string>
  /** raw `node:`/bare-builtin usage, for `@types/node` */
  usesNode: boolean
  /** raw `bun:` usage, for `@types/bun` */
  usesBun: boolean
  /** every `package.json` script body, joined — reach path 7 */
  scripts: string
}

function scan(root: string): Scan {
  const imported = new Set<string>()
  let usesNode = false
  let usesBun = false

  for (const file of walk(root)) {
    const text = stripCommentLines(readFileSync(file, "utf8"))
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
    const config = parseJSONC(readFileSync(join(root, entry), "utf8")) as {
      extends?: string | string[]
      compilerOptions?: { types?: string[] }
    }
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

  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    scripts?: Record<string, string>
  }
  const scripts = Object.values(manifest.scripts ?? {}).join("\n")

  return { imported, usesNode, usesBun, scripts }
}

/** `@types/foo` is imported as bare `foo`; `@types/scope__pkg` as `@scope/pkg`. */
function typesTargetOf(name: string): string | undefined {
  if (!name.startsWith("@types/")) return undefined
  const tail = name.slice("@types/".length)
  return tail.includes("__") ? `@${tail.replace("__", "/")}` : tail
}

/** The reverse: a type-only import of bare `foo` is declared by `@types/foo`. */
function typesPackageFor(name: string): string {
  return name.startsWith("@") ? `@types/${name.slice(1).replace("/", "__")}` : `@types/${name}`
}

/**
 * Reach path 7. The binaries a dependency installs, read from its own manifest wherever bun put it
 * (the package's `node_modules`, else the hoisted root). A dependency with no resolvable manifest
 * has no binaries.
 */
function binNamesOf(dependency: string, from: string): string[] {
  for (const base of [from, REPO_ROOT]) {
    const manifest = join(base, "node_modules", dependency, "package.json")
    if (!existsSync(manifest)) continue
    const bin = (JSON.parse(readFileSync(manifest, "utf8")) as { bin?: string | Record<string, string> }).bin
    if (!bin) return []
    return typeof bin === "string" ? [dependency.split("/").pop()!] : Object.keys(bin)
  }
  return []
}

function invokedByScript(dependency: string, root: string, scripts: string): boolean {
  if (!scripts) return false
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return [dependency, ...binNamesOf(dependency, root)].some((name) =>
    new RegExp(`(?:^|[\\s"'/])${escape(name)}(?:$|[\\s"'])`, "m").test(scripts),
  )
}

describe("workspace dependency ledger", () => {
  const packages = workspacePackages()

  test("the ledger sees every workspace package", () => {
    // The point of the 2026-09-03 extension. If a package is added and this list does not grow,
    // the discovery above is what broke, not the package.
    expect(Object.keys(packages).sort()).toEqual([
      "app",
      "core",
      "desktop",
      "dht",
      "effect-drizzle-sqlite",
      "host",
      "http-recorder",
      "llm",
      "novaclaw",
      "plugin",
      "protocol",
      "schema",
      "script",
      "sdk",
      "server",
      "session-ui",
      "ui",
      "watchdog",
    ])
    for (const pkg of Object.keys(KEPT_WITHOUT_IMPORTS)) {
      expect(packages, `ledger names an unknown package ${pkg}`).toHaveProperty(pkg)
    }
    for (const pkg of Object.keys(KNOWN_UNDECLARED)) {
      expect(packages, `ledger names an unknown package ${pkg}`).toHaveProperty(pkg)
    }
  })

  for (const [pkg, root] of Object.entries(packages)) {
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
    const declared: Record<string, string> = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    }
    const result = scan(root)

    const isSatisfied = (name: string) => {
      if (result.imported.has(name)) return true
      if (name === "@types/bun") return result.usesBun
      if (name === "@types/node") return result.usesNode
      const target = typesTargetOf(name)
      if (target && result.imported.has(target)) return true
      return invokedByScript(name, root, result.scripts)
    }

    test(`${pkg}: every declared dependency is imported, or ledgered with a reason`, () => {
      const ledger = { ...KEPT_EVERYWHERE, ...(KEPT_WITHOUT_IMPORTS[pkg] ?? {}) }
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
        .filter((name) => !(name in declared) && !(typesPackageFor(name) in declared))
        .filter((name) => name !== own)
        .sort()
      expect(undeclared).toEqual([...(KNOWN_UNDECLARED[pkg] ?? [])].sort())
    })
  }

  /**
   * A shared entry is a reason given once for many packages. It goes stale the same way a
   * per-package one does — when no package still needs it — so it may not outlive its last
   * zero-import declaration. (Some packages DO import `typescript`, in test ledgers; the entry
   * covers the ones that do not.)
   */
  test("every shared kept-everywhere entry still explains at least one declaration", () => {
    for (const name of Object.keys(KEPT_EVERYWHERE)) {
      const stillNeeded = Object.values(packages).some((root) => {
        const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"))
        const declared = name in (manifest.dependencies ?? {}) || name in (manifest.devDependencies ?? {})
        if (!declared) return false
        const result = scan(root)
        return !result.imported.has(name) && !invokedByScript(name, root, result.scripts)
      })
      expect(stillNeeded, `${name} is in KEPT_EVERYWHERE but every declaring package now reaches it`).toBe(true)
    }
  })

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
      const manifest = JSON.parse(readFileSync(join(packages[pkg]!, "package.json"), "utf8"))
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
    const result = scan(packages.app!)
    expect(result.imported.has("@dnd-kit/solid")).toBe(true)
    expect(result.imported.has("@thisbeyond/solid-dnd")).toBe(true)
  })

  /**
   * The scanner's own traps, pinned so a "simplification" cannot reopen them. Each line is a shape
   * that once produced a false positive; none of those may count as an import, and the three real
   * forms beneath them must.
   */
  test("the scanner ignores prose, method calls named require, and virtual modules", () => {
    const fixture = [
      `// Baileys dynamic-imports them: without externalizing, \`import("audio-decode")\` fails`,
      ` * a comment line inside a block: require("phantom-block")`,
      `const error = yield* Effect.flip(skill.require("missing-skill"))`,
      `import("novaclaw-web-ui.gen.ts").then((m) => m.default)`,
      `import { real } from "real-package"`,
      `const lazy = await import("lazy-package")`,
      `const cjs = require("cjs-package")`,
    ].join("\n")
    const seen = new Set<string>()
    for (const pattern of SPECIFIER_PATTERNS) {
      pattern.lastIndex = 0
      for (const match of stripCommentLines(fixture).matchAll(pattern)) {
        const name = packageNameOf(match[1]!)
        if (name) seen.add(name)
      }
    }
    expect([...seen].sort()).toEqual(["cjs-package", "lazy-package", "real-package"])
  })
})
