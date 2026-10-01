import { appendFileSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { BUILD_MEMORY_LIMIT_BYTES, buildEnvironment, buildMemoryBoundary } from "./lib/build-memory"
import { enforce } from "./lib/heavy-guard"

const command = process.argv.slice(2)
if (command[0] === "--") command.shift()
if (command.length === 1 && command[0] === "--verify") {
  const boundary = await buildMemoryBoundary()
  if (!boundary.inherited) throw new Error("Build verification requires an inherited process tree memory boundary")
  process.exit(0)
}
if (command.length === 0) throw new Error("Usage: bounded-build.ts -- <command> [arguments]")
const boundary = await buildMemoryBoundary()
if (!boundary.inherited)
  enforce("a desktop build", process.argv, {
    minimumFreeBytes: BUILD_MEMORY_LIMIT_BYTES,
    committedReservationBytes: BUILD_MEMORY_LIMIT_BYTES,
    requireMeasurement: true,
  })
const child = Bun.spawn(command, {
  env: buildEnvironment(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
  windowsHide: true,
})
const exitCode = await child.exited
if (!boundary.inherited) {
  const memory = boundary.read()
  const scratch = resolve(import.meta.dir, "../tmp")
  mkdirSync(scratch, { recursive: true })
  appendFileSync(resolve(scratch, "build-memory.jsonl"), JSON.stringify({ command, exitCode, ...memory }) + "\n")
  console.log(`Build process tree peak: ${(memory.peakBytes / 1024 ** 2).toFixed(1)} MiB / 1280 MiB`)
  if (memory.peakBytes > BUILD_MEMORY_LIMIT_BYTES) throw new Error("The build exceeded the 1280 MiB budget")
  if (exitCode !== 0) console.error("Build failed under the 1280 MiB process tree limit; no uncapped retry will run.")
}
process.exit(exitCode)
