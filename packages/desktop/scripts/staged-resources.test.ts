import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

import type { Configuration } from "electron-builder"
import { hostLibraryName, verifyStagedResources, type StagedResource } from "./staged-resources"

/**
 * 🔴 **A packaging step that verifies by not throwing verifies nothing.** An `extraResources` `from:`
 * pointing at a missing or empty directory is not an electron-builder error — it copies nothing and
 * the pack succeeds — and every native tree the app stages fails SILENTLY when it is absent. This
 * repo has shipped that class twice: a renderer served out of a Vite cache, and a native build
 * degraded by a soft catch. Both times every step reported success.
 *
 * ⚠️ So every case below has BOTH arms. A check that always passes and a check that always fails are
 * indistinguishable from one arm, and "the build did not complain" is the evidence the two shipped
 * incidents also had.
 */

const PE = Buffer.from([0x4d, 0x5a, 0x90, 0x00])
const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46])

let root: string
const warnings: string[] = []

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "novaclaw-staged-"))
  warnings.length = 0
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const stage = (to: string, files: Record<string, Buffer | string> = {}) => {
  const directory = path.join(root, to)
  mkdirSync(directory, { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(directory, name), body)
  return directory
}

const verify = (
  resources: readonly StagedResource[],
  channel: "dev" | "beta" | "prod" = "prod",
  platform: NodeJS.Platform = "win32",
) =>
  verifyStagedResources({
    resources,
    channel,
    platform,
    label: "staged resources",
    resolve: (entry) => path.join(root, entry.to),
    warn: (message) => warnings.push(message),
  })

const HOST: StagedResource = { from: "../host/build/", to: "host/" }
const DHT: StagedResource = { from: "../dht/build/", to: "dht/" }
const WATCHDOG: StagedResource = { from: "../watchdog/build/", to: "watchdog/" }
const RIPGREP: StagedResource = { from: "resources/third-party/ripgrep/", to: "third-party/ripgrep/" }

test("the native host module must be present, non-empty and built for THIS platform", () => {
  // Arm 1 — absent. This is RF-26's case: the entry was in the config, `prebuild` normally filled it,
  // and a direct `electron-builder` invocation staged nothing while the pack reported success.
  expect(() => verify([HOST])).toThrow(/host\/.*REQUIRED/)

  // Arm 2 — the directory exists and the library does not. Distinct from the above because a
  // half-populated staging tree is what a partial or interrupted build actually leaves behind.
  stage("host/", { "README.txt": "not a library" })
  expect(() => verify([HOST])).toThrow(/host\.dll is missing/)

  // Arm 3 — present and EMPTY. A zero-byte file is what a failed link leaves, and existence alone
  // would call it verified.
  stage("host/", { "host.dll": "" })
  expect(() => verify([HOST])).toThrow(/present but EMPTY/)

  // Arm 4 — present, non-empty, and built for the wrong platform. "The binary exists" is a weaker
  // claim than "the binary can load here", and this is the gap between them.
  stage("host/", { "host.dll": ELF })
  expect(() => verify([HOST])).toThrow(/not a Windows PE image/)

  // Arm 5 — the passing half. Without this the four refusals above are satisfied by a check that
  // refuses everything.
  stage("host/", { "host.dll": PE })
  expect(verify([HOST])).toEqual([{ to: "host/", verdict: "verified" }])
})

test("macOS has no host backend, so its absence is not a degradation there", () => {
  expect(hostLibraryName("darwin")).toBeUndefined()
  expect(hostLibraryName("win32")).toBe("host.dll")
  // `host.so`, not `libhost.so`: the loader in `packages/host/src/host.bun.ts` resolves
  // `host.${suffix}` from `bun:ffi`, so the `lib` prefix the build used to emit was a file it
  // would never look for — the Linux watcher could not load, silently.
  expect(hostLibraryName("linux")).toBe("host.so")
  // Nothing staged at all, and it still passes — the one platform where that is the correct answer.
  expect(verify([HOST], "prod", "darwin")).toEqual([{ to: "host/", verdict: "not-applicable" }])
})

test("an EMPTY staged directory fails exactly like a missing one", () => {
  // ⚠️ The shape that makes this check worth having. `extraResources` copies an empty tree without
  // complaint, so the entry looks honoured in the build log and the product ships with nothing there.
  stage("third-party/ripgrep/")
  expect(() => verify([RIPGREP])).toThrow(/holds no non-empty file/)

  stage("third-party/ripgrep/", { "rg.exe": PE })
  expect(verify([RIPGREP])).toEqual([{ to: "third-party/ripgrep/", verdict: "verified" }])
})

test("the DHT keeps its development exemption and loses it on a release channel", () => {
  expect(verify([DHT], "dev")).toEqual([{ to: "dht/", verdict: "absent" }])
  expect(warnings.join("\n")).toContain("DEVELOPMENT ONLY")

  expect(() => verify([DHT], "beta")).toThrow(/dht\/.*REQUIRED/)
  expect(() => verify([DHT], "prod")).toThrow(/dht\/.*REQUIRED/)
})

test("the watchdog is optional on every channel — most machines have no cargo", () => {
  expect(verify([WATCHDOG], "prod")).toEqual([{ to: "watchdog/", verdict: "absent" }])
  expect(warnings.join("\n")).toContain("watchdog/")

  // Optional does NOT mean unchecked: a binary that is there is still held to the platform rule.
  stage("watchdog/", { "novaclaw-watchdog.exe": ELF })
  expect(() => verify([WATCHDOG], "prod")).toThrow(/not a Windows PE image/)

  stage("watchdog/", { "novaclaw-watchdog.exe": PE })
  expect(verify([WATCHDOG], "prod")).toEqual([{ to: "watchdog/", verdict: "verified" }])
})

test("a staged resource nobody classified fails the build by name", () => {
  // 🔴 The arm that keeps the ledger from going stale. Adding a native tree to the package without
  // saying what its absence MEANS is how `host/` ended up with no guard while its two neighbours had
  // one each; here it is a build failure rather than a thing somebody has to notice.
  stage("gpu-shaders/", { "shader.bin": PE })
  expect(() => verify([{ from: "../gpu/build/", to: "gpu-shaders/" }])).toThrow(
    /nothing says whether "gpu-shaders\/" may be missing/,
  )
})

test("every entry the packager actually copies is classified", async () => {
  // Read the LIVE config rather than a transcription of it: the entry somebody forgets to classify
  // is by definition the one a hand-kept list in this file would also forget.
  const module = await import(`../electron-builder.config.ts?staged=${Date.now()}`)
  const resources = (module.default as Configuration).extraResources as readonly StagedResource[]

  expect(resources.length).toBeGreaterThan(3)
  // 🔴 The native host module, which had neither a hook arm nor a config assertion while both of its
  // neighbours had one each. Removing the entry is the other way this ships absent, and the ledger
  // above cannot see an entry that is no longer there.
  expect(resources).toContainEqual({ from: "../host/build/", to: "host/" })

  for (const entry of resources) {
    // Everything is staged so nothing can fail for absence — the only failure available here is the
    // unclassified arm, which is what this case is about.
    stage(entry.to, { "host.dll": PE, "novaclaw-watchdog.exe": PE, "placeholder.bin": PE })
    expect(() => verify([entry])).not.toThrow()
  }
})
