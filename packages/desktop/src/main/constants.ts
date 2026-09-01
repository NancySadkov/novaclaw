type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.NOVACLAW_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

/**
 * 🔴 NC-SEC-033 — base64 sha256 of `packages/app/public/oc-theme-preload.js`, so the renderer policy
 * can admit that one inline script by hash instead of granting `script-src 'unsafe-inline'`.
 *
 * ⚠️ A build define (`electron.vite.config.ts`), computed from the same file the theme-preload vite
 * plugin inlines verbatim. There is nothing to compute at runtime: the header is set before any
 * document body exists in dev, and the app-package source is not present in a packaged build.
 *
 * ⚠️ Deliberately NOT defaulted. An empty value must reach `rendererCsp`, which refuses it — a
 * fallback here would quietly restore the very grant this removed, or emit `'sha256-'`, which
 * Chromium treats as an invalid source expression.
 */
export const THEME_PRELOAD_SHA256: string = import.meta.env.NOVACLAW_THEME_PRELOAD_SHA256 ?? ""
