#!/usr/bin/env bun

import { Script } from "@novaclaw/script"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dir = path.resolve(__dirname, "..")

process.chdir(dir)

const generated = await import("./generate.ts")

await Bun.build({
  target: "node",
  // Resolve the core's conditional `#sqlite`/`#pty`/`#fff` imports (package.json `imports`) to
  // their NODE variants. Without this, Bun.build applies its own `bun` condition even under
  // `target: "node"`, so the bundle pulls in `sqlite.bun.ts` (→ `bun:sqlite`) etc. — which the
  // Electron utilityProcess sidecar (plain Node) can't load (ERR_UNSUPPORTED_ESM_URL_SCHEME).
  conditions: ["node"],
  entrypoints: ["./src/node.ts"],
  outdir: "./dist/node",
  format: "esm",
  sourcemap: "linked",
  // `@mtcute/bun` is the Bun-only Telegram-user driver dep (it imports `bun:sqlite`). The driver
  // loads it by DYNAMIC import behind a `typeof Bun` guard, so under Node it's never reached — but
  // Bun.build would otherwise INLINE it into this bundle and hoist its `bun:sqlite` import to the
  // top, breaking the Node sidecar at load. Keep it external so the lazy import stays lazy.
  external: ["jsonc-parser", "@lydell/node-pty", "@mtcute/bun"],
  define: {
    NOVACLAW_MODELS_DEV: generated.modelsData,
    NOVACLAW_CHANNEL: `'${Script.channel}'`,
  },
  files: {
    "novaclaw-web-ui.gen.ts": "",
  },
})

console.log("Build complete")
