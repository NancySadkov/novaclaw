import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

/**
 * ─── every INSTALL-TIME network fetch, and what verifies it ─────────────────────────────────────
 *
 * ``: *"Pin or eliminate install-time network fallbacks lacking digest/signature
 * verification"* — under a file header that says *"every finding is re-measured at app HEAD before
 * dispatch; stale counts are not work."* This is that re-measurement, turned into something that
 * fails when it stops being true, because an audit written into a report is a fact about the day it
 * was written.
 *
 * The audit, 2026-08-12:
 *
 * | package | install script | network | what verifies it |
 * |---|---|---|---|
 * | `electron` | `install.js` via `@electron/get` | ~354 MB artifact | `checksums.json` **shipped inside the package**, so the digest is chained to `bun.lock`'s integrity hash for `electron` itself |
 * | `esbuild` | `install.js` | only on the `--no-optional` path | nothing — a raw tarball fetch. Unreachable while the platform optionalDependency is in the lockfile |
 * | `protobufjs` | `scripts/postinstall` | none | n/a — it reads package.json files and prints warnings |
 *
 * ⚠️ **The two residues are named rather than described as clean.**
 *  1. `esbuild`'s fallback is protected by the LOCKFILE, not by a digest. If the platform package
 *     ever leaves the lockfile, an unverified tarball fetch becomes reachable.
 *  2. `electron_use_remote_checksums` (and its `npm_config_` twin) swaps the packaged checksums for
 *     ones fetched from the release — downgrading a pin we control to trust-on-first-use.
 *
 * ⚠️ Skips when `node_modules` is absent, and SAYS SO by asserting the skip condition rather than
 * quietly passing: a ledger that reads an empty directory and reports green is the vacuous pass this
 * repo has paid for four times.
 */

const root = path.resolve(import.meta.dir, "..", "..", "..")
const store = path.join(root, "node_modules", ".bun")
const installed = fs.existsSync(store)

/** The resolved package directory for `name`, or undefined when it is not installed. */
const packageDir = (name: string): string | undefined => {
  const scoped = name.startsWith("@") ? name.replace("/", "+") : name
  const entry = fs
    .readdirSync(store)
    .filter((dir) => dir.startsWith(`${scoped}@`))
    .sort()
    .at(-1)
  if (entry === undefined) return undefined
  const resolved = path.join(store, entry, "node_modules", ...name.split("/"))
  return fs.existsSync(resolved) ? resolved : undefined
}

const read = (dir: string, file: string) => {
  const target = path.join(dir, file)
  return fs.existsSync(target) ? fs.readFileSync(target, "utf8") : undefined
}

describe.skipIf(!installed)("install-time network fetches", () => {
  test("the ledger can see the dependency store at all", () => {
    // The guard the skip cannot give: `describe.skipIf` hides a missing store, but a store that
    // exists and resolves NOTHING would run every assertion below against undefined.
    expect(installed).toBe(true)
    expect(packageDir("electron")).toBeDefined()
    expect(packageDir("esbuild")).toBeDefined()
  })

  test("electron's artifact is verified against checksums SHIPPED IN THE PACKAGE, not fetched", () => {
    const dir = packageDir("electron")!
    const install = read(dir, "install.js")
    expect(install).toBeDefined()
    // It downloads — 354 MB of it — so the question is never "does it fetch" but "against what".
    expect(install).toContain("@electron/get")
    // `require('./checksums.json')` is the pin: a local file inside a package whose own tarball is
    // integrity-hashed by bun.lock. Passing `undefined` here is what makes it remote.
    expect(install).toContain("require('./checksums.json')")
    const checksums = read(dir, "checksums.json")
    expect(checksums).toBeDefined()
    expect(Object.keys(JSON.parse(checksums!)).length).toBeGreaterThan(10)
  })

  test("nothing in this repo sets the env that downgrades that pin to a remote fetch", () => {
    // ⚠️ Reads the FILES rather than `process.env`: the variable is consumed by a child process at
    // install time, so a test asserting on its own environment would be asserting about the wrong
    // process and would pass no matter what the repo does.
    const roots = ["package.json", "script", "packages/desktop/package.json"]
    const offenders: string[] = []
    const walk = (target: string) => {
      if (!fs.existsSync(target)) return
      const info = fs.statSync(target)
      if (info.isDirectory()) {
        for (const entry of fs.readdirSync(target)) walk(path.join(target, entry))
        return
      }
      if (!/\.(json|ts|js|yml|yaml|cmd|sh|ps1)$/.test(target)) return
      const body = fs.readFileSync(target, "utf8")
      if (/electron_use_remote_checksums/i.test(body)) offenders.push(path.relative(root, target))
    }
    for (const entry of roots) walk(path.join(root, entry))
    expect(offenders).toEqual([])
  })

  test("esbuild's unverified fallback stays unreachable — the platform package is a real dependency", () => {
    const dir = packageDir("esbuild")!
    const install = read(dir, "install.js")
    expect(install).toBeDefined()
    // The fallback exists and fetches a tarball with NO digest check. That is fine only because it is
    // gated on `require.resolve` failing, which happens under `--no-optional`.
    expect(install).toContain("registry.npmjs.org")
    const manifest = JSON.parse(read(dir, "package.json")!) as { optionalDependencies?: Record<string, string> }
    const platforms = Object.keys(manifest.optionalDependencies ?? {})
    expect(platforms.length).toBeGreaterThan(5)
    // …and the one THIS platform needs is actually installed, which is the condition that keeps the
    // fetch unreachable here. If this goes red, the fallback is live and unverified.
    const key = `@esbuild/${process.platform}-${process.arch}`
    expect(platforms).toContain(key)
    expect(packageDir(key)).toBeDefined()
  })

  test("protobufjs's postinstall touches no network", () => {
    const dir = packageDir("protobufjs")
    if (dir === undefined) return
    const script = read(dir, "scripts/postinstall.js")
    expect(script).toBeDefined()
    expect(script).not.toContain("https")
    expect(script).not.toContain('require("http')
  })

  test("trustedDependencies is exactly the packages whose install scripts we audited", () => {
    // 🔴 `trustedDependencies` is a PERMISSION LIST — each entry lets a package run arbitrary code at
    // install time. An entry added without an audit is a standing grant nobody decided to give, and
    // this list is short enough that pinning it exactly costs nothing and catches that.
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
      trustedDependencies?: string[]
    }
    expect([...(manifest.trustedDependencies ?? [])].sort()).toEqual(["electron", "esbuild", "protobufjs"])
  })
})
