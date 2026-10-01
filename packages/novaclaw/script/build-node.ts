#!/usr/bin/env bun

import { Script } from "@novaclaw/script"
import { mkdirSync, readdirSync, rmSync } from "node:fs"
import path from "node:path"

const dir = path.resolve(import.meta.dir, "..")
process.chdir(dir)

const prepare = process.argv.includes("--prepare")
const verify = process.argv.includes("--verify")
if (prepare === verify || !process.env.NOVACLAW_NODE_BUILD_DIR)
  throw new Error("Run script/build-node.bat to build the Node sidecar")
const scratch = path.resolve(dir, "../../tmp")
const planDirectory = path.resolve(process.env.NOVACLAW_NODE_BUILD_DIR)
if (!planDirectory.startsWith(scratch + path.sep)) throw new Error("Unexpected Node build directory")
const output = path.resolve(dir, "dist/node")

if (prepare) {
  const generated = await import("./generate.ts")
  if (!output.startsWith(path.resolve(dir, "dist") + path.sep)) throw new Error("Unexpected Node output directory")
  rmSync(output, { recursive: true, force: true })
  mkdirSync(planDirectory, { recursive: true })
  await Bun.write(
    path.join(planDirectory, "plan.json"),
    JSON.stringify([
      {
        runtime: "node",
        root: dir,
        output,
        entryPoints: ["./src/node.ts", "./src/session-worker-node.ts", "./src/memory-worker-node.ts"],
        sourcemaps: Script.channel !== "prod",
        define: {
          NOVACLAW_MODELS_DEV: JSON.stringify(generated.modelsData),
          NOVACLAW_CHANNEL: JSON.stringify(Script.channel),
        },
      },
    ]),
  )
} else {
  for (const name of ["node.js", "session-worker-node.js", "memory-worker-node.js"])
    if (!(await Bun.file(path.join(output, name)).exists())) throw new Error(`Missing Node sidecar entry ${name}`)
  for (const name of readdirSync(output).filter((name) => name.endsWith(".js"))) {
    const bundled = await Bun.file(path.join(output, name)).text()
    if (/\b(?:from|import\(|require\()\s*["']bun:/.test(bundled))
      throw new Error(`${name} contains a Bun runtime import`)
  }
  rmSync(planDirectory, { recursive: true, force: true })
  console.log("Build complete; run verify:sidecar before release")
}
