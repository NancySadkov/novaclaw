#!/usr/bin/env bun
/**
 * Build and publish the DHT sidecar.
 *
 * Release mode is the default and is strict. `--development` is the one explicit degradation: it
 * may finish without a sidecar when Rust is unavailable, but it still clears old staging first so
 * a failed build can never borrow an executable from an earlier checkout.
 */
import { existsSync } from "node:fs"
import { chmod, copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  DHT_ARTIFACT_SCHEMA,
  dhtExecutableName,
  expectedDhtIdentity,
  probeDhtExecutable,
  type DhtArtifactIdentity,
  type DhtArtifactManifest,
} from "./protocol"

interface CargoResult {
  readonly success: boolean
  readonly exitCode: number | null
}

export interface DhtBuildOptions {
  readonly root?: string
  readonly development: boolean
  readonly cargo?: string | null
  readonly productVersion?: string
  readonly runCargo?: (input: {
    readonly cargo: string
    readonly root: string
    readonly env: NodeJS.ProcessEnv
  }) => CargoResult
  readonly verify?: (executable: string, expected: DhtArtifactIdentity) => void
}

export type DhtBuildResult = { readonly status: "published"; readonly path: string } | { readonly status: "absent" }

const DEFAULT_ROOT = path.dirname(fileURLToPath(import.meta.url))

function defaultCargoRunner(input: { cargo: string; root: string; env: NodeJS.ProcessEnv }): CargoResult {
  return Bun.spawnSync([input.cargo, "build", "--release"], {
    cwd: input.root,
    env: input.env,
    stdout: "inherit",
    stderr: "inherit",
  })
}

function absentOrThrow(development: boolean, message: string): DhtBuildResult {
  if (!development) throw new Error(message)
  console.warn(`DEVELOPMENT ONLY: ${message}`)
  console.warn("The dev package will omit public DHT discovery; beta/prod builds refuse this degradation.")
  return { status: "absent" }
}

/**
 * Clear, build, authenticate, then atomically publish one sidecar directory.
 *
 * The destination and Cargo's final executable are removed before Cargo runs. That order is the
 * stale-artifact boundary: neither Cargo failure nor a missing toolchain can leave something that
 * electron-builder mistakes for this build's output.
 */
export async function buildDht(options: DhtBuildOptions): Promise<DhtBuildResult> {
  const root = options.root ?? DEFAULT_ROOT
  const executableName = dhtExecutableName()
  const built = path.join(root, "target", "release", executableName)
  const shippedDirectory = path.join(root, "build")
  const temporaryDirectory = path.join(root, "target", `.novaclaw-dht-package-${process.pid}-${Date.now()}`)

  await rm(shippedDirectory, { recursive: true, force: true })
  await rm(temporaryDirectory, { recursive: true, force: true })
  await rm(built, { force: true })

  const cargo = options.cargo === undefined ? Bun.which("cargo") : options.cargo
  if (cargo === null)
    return absentOrThrow(
      options.development,
      "the DHT sidecar requires Cargo, but Cargo is not on PATH; refusing to create a release without it.",
    )

  const expected = await expectedDhtIdentity(root, options.productVersion)
  const runCargo = options.runCargo ?? defaultCargoRunner
  const result = runCargo({
    cargo,
    root,
    env: {
      ...process.env,
      NOVACLAW_DHT_PROTOCOL_VERSION: expected.protocol,
      NOVACLAW_DHT_PRODUCT_VERSION: expected.version,
      NOVACLAW_DHT_SOURCE_ID: expected.source,
    },
  })
  if (!result.success || !existsSync(built))
    return absentOrThrow(
      options.development,
      `the DHT sidecar failed to build (Cargo exit ${String(result.exitCode)}); no artifact was staged.`,
    )

  const verify = options.verify ?? probeDhtExecutable
  verify(built, expected)

  try {
    await mkdir(temporaryDirectory, { recursive: true })
    const temporaryExecutable = path.join(temporaryDirectory, executableName)
    await copyFile(built, temporaryExecutable)
    if (process.platform !== "win32") await chmod(temporaryExecutable, (await stat(built)).mode)
    const manifest: DhtArtifactManifest = {
      schema: DHT_ARTIFACT_SCHEMA,
      executable: executableName,
      ...expected,
    }
    await writeFile(path.join(temporaryDirectory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")

    // Read the files back before publication. This catches a truncated/corrupt temporary write while
    // the public staging path is still absent.
    if ((await readFile(temporaryExecutable)).byteLength === 0) throw new Error("the built DHT executable is empty")
    JSON.parse(await readFile(path.join(temporaryDirectory, "manifest.json"), "utf8"))
    await rename(temporaryDirectory, shippedDirectory)
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true })
    throw error
  }

  const shipped = path.join(shippedDirectory, executableName)
  console.log(
    `built ${path.relative(process.cwd(), shipped)} (${((await stat(shipped)).size / 1048576).toFixed(1)} MB)`,
  )
  return { status: "published", path: shipped }
}

if (import.meta.main) {
  const allowed = new Set(["--development"])
  const unknown = process.argv.slice(2).filter((arg) => !allowed.has(arg))
  if (unknown.length > 0) throw new Error(`unknown DHT build argument(s): ${unknown.join(", ")}`)
  await buildDht({ development: process.argv.includes("--development") })
}
