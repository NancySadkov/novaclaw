import { defineConfig } from "electron-vite"
import appPlugin from "@novaclaw/app/vite"
import { copyFile, mkdir, readdir } from "node:fs/promises"

import { resolveChannel } from "../../script/lib/channel"

const NOVACLAW_SERVER_DIST = "../novaclaw/dist/node"

// ONE resolver — see script/lib/channel.ts. The value below becomes the `NOVACLAW_CHANNEL` build
// define, i.e. `InstallationChannel`, i.e. the instance data dir and DB filename. It must agree with
// electron-builder.config.ts's app id, and until this was shared it did not (the "latest" alias).
const channel = resolveChannel()

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    define: {
      "import.meta.env.NOVACLAW_CHANNEL": JSON.stringify(channel),
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
          const output = "./out/main/chunks"
          await mkdir(output, { recursive: true })
          for (const name of await readdir(NOVACLAW_SERVER_DIST)) {
            if (name !== "node.js" && name !== "session-worker-node.js" && !name.endsWith(".wasm")) continue
            // The server is already a complete Bun bundle. Treat it like the WASM payload: copy it
            // verbatim instead of making Rollup parse and re-emit 23 MB of generated JavaScript.
            // Parsing that bundle was the desktop build's dominant avoidable RAM spike.
            const packagedName =
              name === "node.js"
                ? "novaclaw-server.js"
                : name === "session-worker-node.js"
                  ? "novaclaw-session-worker.js"
                  : name
            await copyFile(`${NOVACLAW_SERVER_DIST}/${name}`, `${output}/${packagedName}`)
          }
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
