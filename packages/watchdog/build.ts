#!/usr/bin/env bun
/**
 * Build the watchdog supervisor.
 *
 * Mirrors `packages/dht/build.ts` exactly, because it is the same shape of problem: a small Rust
 * binary the app is better with and correct without, on machines that may have never heard of Rust.
 *
 * ⚠️ **A missing cargo toolchain is NOT a failure.** Requiring it would turn a convenience into a
 * build dependency for everyone, which is the trade `packages/dht` already refused. An instance with
 * no watchdog behaves exactly as NovaClaw did before one existed: the in-process supervisor still
 * restarts a crashed sidecar, and only the outermost layer — surviving the death of the supervisor
 * itself — is missing.
 *
 * 🔴 **But it must SAY SO, loudly, on stdout.** `packages/host`'s build records why in as many
 * words, and the 0.1.63 release proved it: a soft catch shrugged, and a week-old `host.dll` shipped
 * with nobody noticing while every test on the build machine was green. The failure here is quieter
 * still — nothing is broken until something crashes, which is exactly when nobody is watching.
 *
 * ⚠️ **Nothing launches this binary yet, and no surface promises that anything does.**
 * `electron-builder.config.ts` records the same position. Do not add a Settings row for it before
 * adoption: a switch that offers what the install cannot do is worse than a missing feature,
 * because the user has been told otherwise. Skipping the build is legitimate; promising is not.
 */
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

/**
 * Clear BOTH possible sources of a borrowed artifact before asking whether this build can produce
 * one. Cargo leaves its last successful executable under `target/release`, while electron-builder
 * copies `build/`; either one surviving a failed or skipped build would let yesterday's watchdog
 * masquerade as today's output.
 *
 * The empty staging directory is deliberate. The watchdog is an optional outer recovery layer, so
 * desktop packaging always has a real source directory to copy even when Cargo is unavailable; an
 * empty directory means "not present in this build", never "reuse whatever happened to be here".
 */
rmSync(staging, { recursive: true, force: true })
mkdirSync(staging, { recursive: true })
rmSync(built, { force: true })

const cargo = Bun.which("cargo")
if (cargo === null) {
  console.log(
    "SKIPPED: the watchdog needs cargo, which is not on PATH.\n" +
      "         NovaClaw builds and runs without it — the in-process supervisor still restarts a\n" +
      "         crashed server; what is missing is the layer that survives the supervisor's own\n" +
      "         death. Install Rust to build it: https://rustup.rs",
  )
  process.exit(0)
}

const result = Bun.spawnSync([cargo, "build", "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (!result.success || !existsSync(built)) {
  // ⚠️ Still not fatal, and still named. A build that FAILED leaves the same hole as one that was
  // skipped, and the difference is the whole of what the person fixing it needs to know.
  console.log(`WARNING: the watchdog did not build (exit ${result.exitCode}). Crashed runs will not auto-restart.`)
  process.exit(0)
}

await Bun.write(shipped, Bun.file(built))
console.log(`built ${path.relative(process.cwd(), shipped)} (${(Bun.file(shipped).size / 1024).toFixed(0)} KB)`)
