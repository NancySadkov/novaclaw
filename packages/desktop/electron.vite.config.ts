import { defineConfig } from "electron-vite"
import appPlugin from "@novaclaw/app/vite"
import * as fs from "node:fs/promises"

const NOVACLAW_SERVER_DIST = "../novaclaw/dist/node"

const channel = (() => {
  const raw = process.env.NOVACLAW_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.NOVACLAW_CHANNEL === "latest") return "prod"
  return "dev"
})()

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
        name: "novaclaw:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:novaclaw-server") return this.resolve(`${NOVACLAW_SERVER_DIST}/node.js`)
        },
      },
      {
        name: "novaclaw:copy-server-assets",
        async writeBundle() {
          for (const l of await fs.readdir(NOVACLAW_SERVER_DIST)) {
            if (!l.endsWith(".wasm")) continue
            await fs.writeFile(`./out/main/chunks/${l}`, await fs.readFile(`${NOVACLAW_SERVER_DIST}/${l}`))
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
      sourcemap: true,
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
        },
      },
    },
  },
})
