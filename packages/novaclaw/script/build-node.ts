#!/usr/bin/env bun

import { Script } from "@novaclaw/script"
import { rm } from "node:fs/promises"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

const result = await Bun.build({
  target: "node",
  // Resolve the core's conditional `#sqlite`/`#pty`/`#fff` imports (package.json `imports`) to
  // their NODE variants. Without this, Bun.build applies its own `bun` condition even under
  // `target: "node"`, so the bundle pulls in `sqlite.bun.ts` (→ `bun:sqlite`) etc. — which the
  // Electron utilityProcess sidecar (plain Node) can't load (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  conditions: ["node"],
  entrypoints: ["./src/node.ts", "./src/session-worker-node.ts"],
  outdir: "./dist/node",
  format: "esm",
  // Production ships scrubbed crash diagnostics and does not consume this 40 MB map. Generating it
  // was also the sidecar build's largest avoidable memory spike on 16 GB machines; keep maps for
  // dev/beta debugging, but do not spend that RAM or disk in the user-facing release artifact.
  sourcemap: Script.channel === "prod" ? "none" : "linked",
  // `@mtcute/bun` is the Bun-only Telegram-user driver dep (it imports `bun:sqlite`). The driver
  // loads it by DYNAMIC import behind a `typeof Bun` guard, so under Node it's never reached — but
  // Bun.build would otherwise INLINE it into this bundle and hoist its `bun:sqlite` import to the
  // top, breaking the Node sidecar at load. Keep it external so the lazy import stays lazy.
  // jsonc-parser's Node entry is UMD and cannot be safely inlined by Bun (its relative requires are
  // preserved). The desktop package therefore declares it alongside node-pty as an explicit runtime
  // dependency of the opaque sidecar, rather than relying on Electron's old accidental rebundle.
  external: ["jsonc-parser", "@lydell/node-pty", "@mtcute/bun"],
  define: {
    NOVACLAW_MODELS_DEV: generated.modelsData,
    NOVACLAW_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "novaclaw-web-ui.gen.ts": "",
  },
})

// The build result was previously DISCARDED, so a failed sidecar build printed "Build complete" and
// left the previous (or no) bundle in place. Found by an outside contributor reconstructing this file
// from scratch, because the published source was missing it entirely — see .gitignore.
if (!result.success) throw new AggregateError(result.logs, "Node sidecar build failed")
if (Script.channel === "prod")
  await Promise.all([
    rm("./dist/node/node.js.map", { force: true }),
    rm("./dist/node/session-worker-node.js.map", { force: true }),
  ])

// The two comments above say WHY `conditions` and `external` are set the way they are. This turns
// that knowledge into a CHECK: if either regresses, a `bun:` import reaches the bundle and the
// Electron sidecar dies at load with ERR_UNSUPPORTED_ESM_URL_SCHEME — a packaged-only failure a
// green suite cannot see, which is the exact class that shipped v0.0.1 and v0.1.0 broken.
for (const name of ["node.js", "session-worker-node.js"]) {
  const bundled = await Bun.file(`./dist/node/${name}`).text()
  if (/\b(?:from|import\(|require\()\s*["']bun:/.test(bundled))
    throw new Error(`${name} contains a \`bun:\` runtime import — check \`conditions: ['node']\` and the external list`)
}

console.log("Build complete")
