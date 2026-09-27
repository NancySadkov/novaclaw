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

// Bun's split build does not remove chunks that disappeared from the current graph. Shipping the
// whole directory would otherwise retain code from an older build, including dependencies that
// have been removed from source. Recreate the output boundary before every sidecar build.
await rm("./dist/node", { recursive: true, force: true })

const result = await Bun.build({
  target: "node",
  // Resolve the core's conditional `#sqlite`/`#pty`/`#fff` imports (package.json `imports`) to
  // their NODE variants. Without this, Bun.build applies its own `bun` condition even under
  // `target: "node"`, so the bundle pulls in `sqlite.bun.ts` (→ `bun:sqlite`) etc. — which the
  // Electron utilityProcess sidecar (plain Node) can't load (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  conditions: ["node"],
  // Dynamic imports become REAL chunks instead of being inlined into one 23 MB file. Measured on the
  // packaged desktop: the entry drops 23.7 MB -> 0.77 MB and `await import()` of it 710 -> 561 ms
  // (n=5, non-overlapping ranges), with `Server.listen` unchanged at ~184 ms — so the work is
  // genuinely deferred rather than moved. That is ~150 ms off every desktop boot.
  //
  // ⚠️ `script/build.ts` sets `splitting: false` for the compiled BINARY, and its reason still holds:
  // split chunks can evaluate circular LayerNode imports in a different order than the source graph,
  // leaving a dependency undefined only AFTER the first HTTP request. It is enabled here — and only
  // here — because something BOOTS this bundle and makes real requests against it, which is the only
  // way that ordering defect is observable. That something used to be `node-sidecar-smoke.mjs` at the
  // end of this build; it is now `script/verify-node-sidecar.ts`, a separate gate, because a build
  // must not fail on a runtime state (see the note at the bottom of this file). Do NOT copy this
  // flag to the binary build without carrying an equivalent check with it.
  splitting: true,
  entrypoints: ["./src/node.ts", "./src/session-worker-node.ts", "./src/memory-worker-node.ts"],
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
    rm("./dist/node/memory-worker-node.js.map", { force: true }),
  ])

// The two comments above say WHY `conditions` and `external` are set the way they are. This turns
// that knowledge into a CHECK: if either regresses, a `bun:` import reaches the bundle and the
// Electron sidecar dies at load with ERR_UNSUPPORTED_ESM_URL_SCHEME — a packaged-only failure a
// green suite cannot see, which is the exact class that shipped v0.0.1 and v0.1.0 broken.
for (const name of ["node.js", "session-worker-node.js", "memory-worker-node.js"]) {
  const bundled = await Bun.file(`./dist/node/${name}`).text()
  if (/\b(?:from|import\(|require\()\s*["']bun:/.test(bundled))
    throw new Error(`${name} contains a \`bun:\` runtime import — check \`conditions: ['node']\` and the external list`)
}

// The sidecar smokes (boot the bundle, then ask it things) are NOT here. They used to be,
// and on 2026-09-27 they failed a 0.1.80 zip build over a legitimately-disabled feature:
// memory had just become opt-in, so a cold `world-memory.list` paid the ~1.3 GB arena
// inside a 30 s capability deadline. A build that boots the product fails for reasons a
// build does not control. They live in `script/verify-node-sidecar.ts` now (`bun run
// verify:sidecar`) and remain mandatory before a release - `splitting: true` above is
// justified by that check, not by this build.

console.log("Build complete")
