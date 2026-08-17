#!/usr/bin/env bun
/**
 * Build the DHT sidecar.
 *
 * ⚠️ **A missing cargo toolchain is NOT a failure.** The app must build on a machine that has never
 * heard of Rust, and an instance without this binary simply finds no peers through the DHT — which
 * the seam already treats as ordinary. Failing the build here would make a convenience into a
 * dependency, which is the shape the whole design refuses.
 *
 * 🔴 But it must SAY SO, loudly, on stdout. `packages/host`'s build records the reason in as many
 * words: the alternative is a release whose file watching is silently dead while every test on the
 * machine that built it was green. A release with no sidecar is silently undiscoverable in exactly
 * the same way, and the person who needs to know is the one running the build.
 */
import { existsSync } from "node:fs"
import path from "node:path"

const root = path.dirname(Bun.fileURLToPath(import.meta.url))
const exe = process.platform === "win32" ? "novaclaw-dht.exe" : "novaclaw-dht"
const built = path.join(root, "target", "release", exe)

const cargo = Bun.which("cargo")
if (cargo === null) {
  console.log(
    "SKIPPED: the DHT sidecar needs cargo, which is not on PATH.\n" +
      "         NovaClaw builds and runs without it — discovery falls back to the LAN, peer exchange\n" +
      "         and addresses the user types. Install Rust to build it: https://rustup.rs",
  )
  process.exit(0)
}

const result = Bun.spawnSync([cargo, "build", "--release"], { cwd: root, stdout: "inherit", stderr: "inherit" })
if (!result.success || !existsSync(built)) {
  // ⚠️ Still not fatal, and still named. A build that fails here leaves the same hole as one that was
  // skipped, and the difference matters to whoever has to fix it.
  console.log(`WARNING: the DHT sidecar did not build (exit ${result.exitCode}). Discovery will not use the DHT.`)
  process.exit(0)
}

console.log(`built ${path.relative(process.cwd(), built)} (${(Bun.file(built).size / 1048576).toFixed(1)} MB)`)
