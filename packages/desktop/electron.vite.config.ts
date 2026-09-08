import { defineConfig } from "electron-vite"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import appPlugin from "@novaclaw/app/vite"

import { resolveChannel } from "@novaclaw/script/channel"
import { copyServerRuntime } from "./scripts/server-runtime-assets"

const NOVACLAW_SERVER_DIST = "../novaclaw/dist/node"

// ONE resolver — see @novaclaw/script/channel. The value below becomes the `NOVACLAW_CHANNEL` build
// define, i.e. `InstallationChannel`, i.e. the instance data dir and DB filename. It must agree with
// electron-builder.config.ts's app id, and until this was shared it did not (the "latest" alias).
const channel = resolveChannel()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

/**
 * 🔴 NC-SEC-033 — the renderer policy admits the theme preload BY HASH, so `script-src` no longer
 * carries `'unsafe-inline'`.
 *
 * ⚠️ Computed from the very file `@novaclaw/app/vite`'s theme-preload plugin inlines, and inlined
 * VERBATIM there — so these bytes are exactly what the browser hashes. Reading the same file is the
 * point: a hash copied into a constant is a second source of truth that goes stale the first time
 * the preload is edited, and the failure is silent (the page renders, the script is blocked, and
 * only the CSP violation log says so).
 *
 * ⚠️ It has to arrive as a build DEFINE. `addRendererHeaders` sets a header in dev and has no
 * document body to hash, so there is nothing to compute at runtime — and in the packaged app the
 * app-package source is not present to read.
 */
const themePreloadSha256 = createHash("sha256")
  .update(readFileSync(new URL("../app/public/oc-theme-preload.js", import.meta.url)))
  .digest("base64")

export default defineConfig({
  main: {
    define: {
      "import.meta.env.NOVACLAW_CHANNEL": JSON.stringify(channel),
      "import.meta.env.NOVACLAW_THEME_PRELOAD_SHA256": JSON.stringify(themePreloadSha256),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts", sidecar: "src/main/sidecar.ts" },
      },
      // Leave external the deps that must not be inlined into the Electron main bundle:
      //   • node-pty — native .node addon (platform-specific)
      //   • Baileys' optionalPeers (audio-decode / jimp / link-preview-js / sharp) — declared
      //     `optionalPeers` and intentionally NOT installed. Baileys dynamic-imports them for its
      //     WhatsApp voice/image paths; without externalizing, Rollup fails to resolve the bare
      //     `import("audio-decode")` in the prebuilt sidecar (dist/node/node.js) and the whole dev
      //     build dies. Externalized, the build passes and the optional path degrades gracefully at
      //     runtime only if actually exercised without the dep (WhatsApp is opt-in anyway).
      //   • @mtcute/bun — the Bun-only Telegram-user driver dep (imports bun:sqlite); kept external
      //     in the node bundle too, so its lazy dynamic import never drags bun:sqlite into the
      //     eager main-process graph (it's guarded off under Node anyway).
      externalizeDeps: {
        include: [nodePtyPkg, "audio-decode", "jimp", "link-preview-js", "sharp", "@mtcute/bun"],
        // Workspace source exports are TypeScript; Electron cannot load them from node_modules.
        exclude: ["@novaclaw/core"],
      },
    },
    plugins: [
      {
        name: "novaclaw:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "novaclaw:copy-server-assets",
        async writeBundle() {
          const output = "./out/main/server-runtime"
          // The producer owns this directory. Copy the COMPLETE output: Bun file-loader assets sit
          // beside chunks and are just as load-bearing as them. The helper replaces the destination
          // first so old content-hash generations cannot survive a rebuild.
          await copyServerRuntime(NOVACLAW_SERVER_DIST, output)
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    plugins: [appPlugin],
    publicDir: "../../../app/public",
    root: "src/renderer",
    build: {
      // Production crash reporting is symbolized from named log events, not renderer source maps.
      // Avoid building and packaging a large map on the low-memory Windows machines NovaClaw targets.
      sourcemap: channel !== "prod",
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
