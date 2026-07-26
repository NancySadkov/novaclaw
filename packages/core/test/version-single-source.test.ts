import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"

import { InstallationVersion } from "../src/installation/version"
import { VERSION } from "../src/installation/version.gen"

// The version has ONE source: the root package.json. Everything else is derived, and this is what
// keeps it that way.
//
// It went wrong in two directions at once before this existed:
//   · the version was copied into 13 workspace package.json files plus three source literals (a UA
//     string, a driver default, a UI fallback), so a release meant editing seventeen places;
//   · the RUNTIME version came from a build-time `NOVACLAW_VERSION` define that the Electron
//     sidecar's builder never set, so the packaged app reported its version as "local" — in /health,
//     in every session record, and to Telegram as the device's app version.
// Both were invisible: nothing failed, the numbers were just wrong. Hence a test.

const ROOT = path.join(import.meta.dir, "..", "..", "..")

const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"))

/** The canonical version, and the ONLY place a human edits it. */
const canonicalRaw: unknown = readJson("package.json").version
const canonical = typeof canonicalRaw === "string" ? canonicalRaw : ""

/** Every workspace package.json, discovered rather than listed — a new package is covered for free. */
const workspacePackages = (() => {
  const dirs = fs
    .readdirSync(path.join(ROOT, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`)
  // `packages/sdk` is not itself a package; its JS client is (see the root workspaces globs).
  const all = [...dirs.filter((dir) => dir !== "packages/sdk"), "packages/sdk/js"]
  return all.filter((dir) => fs.existsSync(path.join(ROOT, dir, "package.json")))
})()

describe("version single source of truth", () => {
  test("the root package.json carries a real version", () => {
    expect(typeof canonicalRaw).toBe("string")
    expect(canonical).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("the sweep actually found the workspace packages", () => {
    // Guards the guard: a broken glob would make every assertion below vacuously true.
    expect(workspacePackages.length).toBeGreaterThan(10)
    expect(workspacePackages).toContain("packages/desktop")
    expect(workspacePackages).toContain("packages/sdk/js")
  })

  test("the generated runtime constant matches the canonical version", () => {
    // If this fails, run `bun run version:sync` from the repo root.
    expect(VERSION).toBe(canonical)
  })

  test("InstallationVersion is the canonical version, never a missing-define fallback", () => {
    expect(InstallationVersion).toBe(canonical)
    expect(InstallationVersion).not.toBe("local")
    expect(InstallationVersion).not.toBe("")
  })

  test("packages/desktop is the ONLY package with its own version, and it is in sync", () => {
    // electron-builder requires a literal version in the app's own package.json (artifact naming +
    // the metadata baked into the packaged app), so this one copy is unavoidable. `version:sync`
    // writes it; this asserts nobody hand-edited one of the two out of agreement.
    expect(readJson("packages/desktop/package.json").version).toBe(canonical)

    const offenders = workspacePackages
      .filter((dir) => dir !== "packages/desktop")
      .filter((dir) => readJson(`${dir}/package.json`).version !== undefined)
    // A version field here is dead weight that WILL drift: these packages are private and never
    // published (we don't use the npm registry). Delete it and read InstallationVersion instead.
    expect(offenders).toEqual([])
  })

  test("no source file hardcodes the current version as a literal", () => {
    // The specific regression this blocks: bumping the release and leaving a literal behind, which
    // is how the websearch User-Agent and the Reddit driver default came to carry stale numbers.
    const literal = `"${canonical}"`
    const searched: string[] = []
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "out") continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue
        // The generated constant is the one place the number is allowed to appear.
        if (entry.name === "version.gen.ts") continue
        searched.push(full)
        if (fs.readFileSync(full, "utf8").includes(literal)) offenders.push(path.relative(ROOT, full))
      }
    }
    walk(path.join(ROOT, "packages", "core", "src"))
    walk(path.join(ROOT, "packages", "app", "src"))

    expect(searched.length).toBeGreaterThan(100)
    expect(offenders).toEqual([])
  })
})
