import { readFileSync } from "node:fs"
import { HTML_EMBED_CSP, HTML_EMBED_PATH } from "@novaclaw/schema/html-embed"
import { htmlEmbedBootstrap } from "@novaclaw/schema/html-embed-bootstrap"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))
const slimShiki = fileURLToPath(new URL("./src/vendor/slim-shiki.js", import.meta.url))
const customThemesOnly = fileURLToPath(new URL("./src/vendor/custom-syntax-themes.js", import.meta.url))

const channel = (() => {
  const raw = process.env.NOVACLAW_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.NOVACLAW_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    // NovaClaw supplies one custom syntax theme. The umbrella entry points also advertise every
    // third-party theme as a dynamic import, making Vite emit an unused asset for every one. Keep
    // the language catalogue and highlighter engines, but give the renderer no bundled themes.
    name: "novaclaw:syntax-theme-boundary",
    // Dependency export resolution otherwise wins before this hook for imports originating inside
    // @pierre/diffs, leaving its full third-party theme catalogue in the production renderer.
    enforce: "pre",
    resolveId(source) {
      if (source === "shiki") return slimShiki
      if (source === "@pierre/theming/themes") return customThemesOnly
    },
  },
  {
    name: "novaclaw-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_NOVACLAW_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "novaclaw-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  {
    /**
     * The agent-canvas bootstrap, emitted into BOTH renderer builds.
     *
     * This plugin is the one seam the web app and the desktop renderer share (`packages/app` and
     * `packages/desktop/src/renderer` are separate roots with separate `index.html` files), so a
     * canvas document placed here cannot exist on one surface and not the other — which is exactly
     * the failure NC-SEC-032 was.
     *
     * ⚠️ Emitted rather than checked in as two `embed.html` files, for the same reason the policy
     * has one home: two copies of a security-relevant document is how the surfaces drifted apart.
     *
     * ⚠️ It is NOT a rollup INPUT. An input would be treated as an app entry — hashed, injected
     * with the module preload and the theme script, and transformed by `transformIndexHtml` above.
     * The canvas host must stay exactly the bytes this function returns.
     */
    name: "novaclaw:canvas-embed",
    configureServer(server) {
      // Dev only. In dev nothing else sets a policy on this document, so the plugin sends it —
      // otherwise a canvas would run unrestricted in dev and restricted in production, and the dev
      // loop would be the one place the containment was never exercised.
      server.middlewares.use((req, res, next) => {
        if (!req.url || req.url.replace(/^\/+/, "").split("?")[0] !== HTML_EMBED_PATH) return next()
        res.setHeader("content-type", "text/html; charset=utf-8")
        res.setHeader("content-security-policy", HTML_EMBED_CSP)
        res.end(htmlEmbedBootstrap())
      })
    },
    generateBundle() {
      this.emitFile({ type: "asset", fileName: HTML_EMBED_PATH, source: htmlEmbedBootstrap() })
    },
  },
  tailwindcss(),
  solidPlugin(),
]
