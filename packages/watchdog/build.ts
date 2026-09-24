#!/usr/bin/env bun
import { existsSync, mkdirSync, rmSync } from "node:fs"
import path from "node:path"

const root = path.dirname(Bun.fileURLToPath(import.meta.url))
const exe = process.platform === "win32" ? "novaclaw-watchdog.exe" : "novaclaw-watchdog"
const built = path.join(root, "target", "release", exe)
/**
 * 🔴 A clean directory holding ONLY the binary, mirroring `packages/host/build/` and `packages/dht/build/`.
 *
 * Packaging copies a DIRECTORY, and `target/release/` is a cargo scratch tree — hundreds of megabytes
 * of intermediate objects beside the ~200 KB we want. Copying it would bloat the installer; naming the
 * file in two places would let them drift.
 */
const staging = path.join(root, "build")
const shipped = path.join(staging, exe)

rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
rmSync(built, { force: true })

const cargo = Bun.which("cargo")
if (cargo === null) {
  throw new Error("The desktop watchdog requires Cargo to build")
}

const result = Bun.spawnSync([cargo, "build", "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (!result.success || !existsSync(built)) {
  throw new Error(`The desktop watchdog did not build (exit ${result.exitCode})`)
}

await Bun.write(shipped, Bun.file(built))
console.log(`built ${path.relative(process.cwd(), shipped)} (${(Bun.file(shipped).size / 1024).toFixed(0)} KB)`)
