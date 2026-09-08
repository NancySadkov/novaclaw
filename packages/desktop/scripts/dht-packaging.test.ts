import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { buildDht } from "../../dht/build"
import {
  DHT_ARTIFACT_SCHEMA,
  dhtExecutableName,
  expectedDhtIdentity,
  verifyDhtArtifactDirectory,
  type DhtArtifactIdentity,
  type DhtProbeRunner,
} from "../../dht/protocol"
import { dhtArtifactRequired, dhtBuildArguments, packagedDhtDirectory } from "./dht-packaging"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ appRoot: string; dhtRoot: string }> {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "novaclaw-dht-package-test-"))
  roots.push(appRoot)
  const dhtRoot = path.join(appRoot, "packages", "dht")
  mkdirSync(path.join(dhtRoot, "src"), { recursive: true })
  await writeFile(path.join(appRoot, "package.json"), JSON.stringify({ version: "9.8.7" }))
  await writeFile(path.join(dhtRoot, "Cargo.toml"), "[package]\nname='fixture'\nversion='0.0.0'\n")
  await writeFile(path.join(dhtRoot, "Cargo.lock"), "# fixture lock\n")
  await writeFile(path.join(dhtRoot, "src", "main.rs"), "fn main() {}\n")
  return { appRoot, dhtRoot }
}

function successfulProbe(identity: DhtArtifactIdentity, inspect?: (options: Parameters<DhtProbeRunner>[1]) => void) {
  return ((_executable, options) => {
    inspect?.(options)
    return {
      status: 0,
      stdout: [identity, { announced: false }, { peers: [] }].map((reply) => JSON.stringify(reply)).join("\n"),
      stderr: "",
    }
  }) satisfies DhtProbeRunner
}

async function writeArtifact(dhtRoot: string, identity: DhtArtifactIdentity): Promise<string> {
  const directory = path.join(dhtRoot, "build")
  const executable = dhtExecutableName()
  mkdirSync(directory, { recursive: true })
  await writeFile(path.join(directory, executable), "fixture executable")
  await writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({ schema: DHT_ARTIFACT_SCHEMA, executable, ...identity }),
  )
  return directory
}

test("only the explicit development channel may omit the DHT sidecar", () => {
  expect(dhtBuildArguments("dev")).toEqual(["--development"])
  expect(dhtBuildArguments("beta")).toEqual([])
  expect(dhtBuildArguments("prod")).toEqual([])
  expect(dhtArtifactRequired("dev")).toBe(false)
  expect(dhtArtifactRequired("beta")).toBe(true)
  expect(dhtArtifactRequired("prod")).toBe(true)
})

test("missing Cargo clears stale staging and fails a release", async () => {
  const { dhtRoot } = await fixture()
  const executable = dhtExecutableName()
  mkdirSync(path.join(dhtRoot, "build"), { recursive: true })
  mkdirSync(path.join(dhtRoot, "target", "release"), { recursive: true })
  writeFileSync(path.join(dhtRoot, "build", executable), "stale staged binary")
  writeFileSync(path.join(dhtRoot, "target", "release", executable), "stale cargo binary")

  await expect(buildDht({ root: dhtRoot, development: false, cargo: null, productVersion: "9.8.7" })).rejects.toThrow(
    "requires Cargo",
  )
  expect(existsSync(path.join(dhtRoot, "build"))).toBe(false)
  expect(existsSync(path.join(dhtRoot, "target", "release", executable))).toBe(false)
})

test("a failed Cargo run cannot leak a prior artifact; development reports explicit absence", async () => {
  const { dhtRoot } = await fixture()
  const executable = dhtExecutableName()
  mkdirSync(path.join(dhtRoot, "build"), { recursive: true })
  writeFileSync(path.join(dhtRoot, "build", executable), "stale staged binary")

  const failed = { success: false, exitCode: 101 }
  await expect(
    buildDht({
      root: dhtRoot,
      development: false,
      cargo: "fixture-cargo",
      productVersion: "9.8.7",
      runCargo: () => failed,
    }),
  ).rejects.toThrow("Cargo exit 101")
  expect(existsSync(path.join(dhtRoot, "build"))).toBe(false)

  const result = await buildDht({
    root: dhtRoot,
    development: true,
    cargo: null,
    productVersion: "9.8.7",
  })
  expect(result).toEqual({ status: "absent" })
  expect(existsSync(path.join(dhtRoot, "build"))).toBe(false)
})

test("a successful build publishes atomically with the compiled source identity", async () => {
  const { dhtRoot } = await fixture()
  const executable = dhtExecutableName()
  let compiledIdentity: DhtArtifactIdentity | undefined
  const result = await buildDht({
    root: dhtRoot,
    development: false,
    cargo: "fixture-cargo",
    productVersion: "9.8.7",
    runCargo: ({ root, env }) => {
      compiledIdentity = {
        protocol: String(env.NOVACLAW_DHT_PROTOCOL_VERSION),
        version: String(env.NOVACLAW_DHT_PRODUCT_VERSION),
        source: String(env.NOVACLAW_DHT_SOURCE_ID),
        platform: process.platform === "win32" ? "windows" : process.platform,
        arch: process.arch === "x64" ? "x86_64" : process.arch === "arm64" ? "aarch64" : process.arch,
      }
      mkdirSync(path.join(root, "target", "release"), { recursive: true })
      writeFileSync(path.join(root, "target", "release", executable), "new binary")
      return { success: true, exitCode: 0 }
    },
    verify: (_path, expected) => {
      if (compiledIdentity === undefined) throw new Error("fixture cargo did not publish an artifact identity")
      expect(expected).toEqual(compiledIdentity)
    },
  })

  expect(result.status).toBe("published")
  if (compiledIdentity === undefined) throw new Error("fixture cargo did not publish an artifact identity")
  const identity = compiledIdentity
  const manifest = JSON.parse(await readFile(path.join(dhtRoot, "build", "manifest.json"), "utf8"))
  expect(manifest).toEqual({ schema: DHT_ARTIFACT_SCHEMA, executable, ...identity })
  expect(await readFile(path.join(dhtRoot, "build", executable), "utf8")).toBe("new binary")
})

test("a verification failure publishes nothing", async () => {
  const { dhtRoot } = await fixture()
  await expect(
    buildDht({
      root: dhtRoot,
      development: false,
      cargo: "fixture-cargo",
      productVersion: "9.8.7",
      runCargo: ({ root }) => {
        mkdirSync(path.join(root, "target", "release"), { recursive: true })
        writeFileSync(path.join(root, "target", "release", dhtExecutableName()), "wrong binary")
        return { success: true, exitCode: 0 }
      },
      verify: () => {
        throw new Error("protocol mismatch")
      },
    }),
  ).rejects.toThrow("protocol mismatch")
  expect(existsSync(path.join(dhtRoot, "build"))).toBe(false)
})

test("staging verification executes version, announce, and find frames", async () => {
  const { dhtRoot } = await fixture()
  const identity = await expectedDhtIdentity(dhtRoot, "9.8.7")
  const directory = await writeArtifact(dhtRoot, identity)
  let input = ""
  const status = await verifyDhtArtifactDirectory(directory, {
    required: true,
    root: dhtRoot,
    productVersion: "9.8.7",
    run: successfulProbe(identity, (options) => (input = options.input)),
  })
  expect(status).toBe("verified")
  expect(
    input
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).op),
  ).toEqual(["version", "announce", "find"])
})

test("release verification rejects absence, stale source, wrong target, and incompatible protocol", async () => {
  const { dhtRoot } = await fixture()
  const directory = path.join(dhtRoot, "build")
  await expect(
    verifyDhtArtifactDirectory(directory, { required: true, root: dhtRoot, productVersion: "9.8.7" }),
  ).rejects.toThrow("required DHT sidecar is absent")

  const identity = await expectedDhtIdentity(dhtRoot, "9.8.7")
  await writeArtifact(dhtRoot, { ...identity, platform: "wrong-platform" })
  await expect(
    verifyDhtArtifactDirectory(directory, {
      required: true,
      root: dhtRoot,
      productVersion: "9.8.7",
      run: successfulProbe(identity),
    }),
  ).rejects.toThrow("platform mismatch")

  await writeArtifact(dhtRoot, { ...identity, arch: "wrong-architecture" })
  await expect(
    verifyDhtArtifactDirectory(directory, {
      required: true,
      root: dhtRoot,
      productVersion: "9.8.7",
      run: successfulProbe(identity),
    }),
  ).rejects.toThrow("arch mismatch")

  await writeArtifact(dhtRoot, identity)
  await writeFile(path.join(dhtRoot, "src", "main.rs"), 'fn main() { println!("changed"); }\n')
  await expect(
    verifyDhtArtifactDirectory(directory, {
      required: true,
      root: dhtRoot,
      productVersion: "9.8.7",
      run: successfulProbe(identity),
    }),
  ).rejects.toThrow("source mismatch")

  const current = await expectedDhtIdentity(dhtRoot, "9.8.7")
  await writeArtifact(dhtRoot, current)
  await expect(
    verifyDhtArtifactDirectory(directory, {
      required: true,
      root: dhtRoot,
      productVersion: "9.8.7",
      run: successfulProbe({ ...current, protocol: "old-protocol" }),
    }),
  ).rejects.toThrow("protocol mismatch")
})

test("packaged resource lookup follows the platform layout", () => {
  expect(packagedDhtDirectory("C:\\artifact\\NovaClaw.exe", "win32")).toBe("C:\\artifact\\resources\\dht")
  expect(packagedDhtDirectory("/artifact/novaclaw", "linux")).toBe("/artifact/resources/dht")
  expect(packagedDhtDirectory("/artifact/NovaClaw.app/Contents/MacOS/NovaClaw", "darwin")).toBe(
    "/artifact/NovaClaw.app/Contents/Resources/dht",
  )
})
