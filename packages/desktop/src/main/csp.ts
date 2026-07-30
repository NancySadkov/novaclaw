/**
 * The renderer window's Content-Security-Policy.
 *
 * Kept in its own electron-free module so `csp.test.ts` can import and parse the real value
 * (`windows.ts` cannot be imported under `bun test` — it pulls in `electron`). Same shape as
 * `renderer-url.ts`: the decision lives in a pure module, the wiring lives in `windows.ts`.
 *
 * ## What the renderer actually loads — measured, not assumed
 *
 * The window loads two ways and this ONE policy has to fit both, because a policy that only
 * fits one is worse than none (it either breaks the dev loop or gives false assurance in the
 * packaged app):
 *
 *   • packaged — `nc://renderer/index.html` through the privileged scheme in `windows.ts`.
 *   • dev      — `${ELECTRON_RENDERER_URL}/index.html`, an electron-vite dev server.
 *
 * They need the SAME policy, which is a finding rather than a convenience: every relaxation
 * Vite's dev server wants (inline script, a `ws:` HMR socket, same-origin ES modules) is
 * already forced by production requirements below. So there is no dev-only weakening here,
 * and no directive was loosened to make HMR work.
 *
 * ## Why each relaxation exists
 *
 * `'unsafe-inline'` in **script-src** — this is the load-bearing one, and it is NOT laziness.
 *   Agent-drawn HTML canvases (AGENTS.md → "the agent-drawn HTML canvases in chat") render as
 *   `<iframe sandbox="allow-scripts" srcdoc="…">` carrying the model's raw, deliberately
 *   unsanitized markup — see `packages/session-ui/src/components/markdown-html-embed.ts`. An
 *   `about:srcdoc` document INHERITS the embedder's CSP (HTML's "determine navigation params
 *   policy container" clones the parent's policy container for `about:srcdoc`), and sandboxing
 *   does not opt it out. Measured 2026-07-30 in Chrome headless: under a parent
 *   `script-src 'nonce-…'` the srcdoc's inline script does not run; under `'unsafe-inline'` it
 *   does. A nonce or hash policy has the same effect as blocking, because the embedded document
 *   is authored by a model at runtime and can carry neither.
 *   ⚠️ So do not "harden" this by dropping `'unsafe-inline'` — that silently kills every HTML
 *   canvas, and no test outside this file would notice. The honest fix is to stop inheriting:
 *   serve embeds from their own origin (a `nc://embed/…` document with its own, looser policy)
 *   and only then tighten this directive.
 *
 * `'wasm-unsafe-eval'` in **script-src** — the renderer bundle compiles WebAssembly
 *   (`WebAssembly.instantiate` in the main chunk; `ghostty-web` is the terminal renderer and
 *   the shiki highlighter worker also carries wasm). Chrome refuses `WebAssembly.Module` under
 *   any script-src that grants neither `'unsafe-eval'` nor `'wasm-unsafe-eval'` — measured, with
 *   the CompileError naming the directive. Dropping this breaks the terminal.
 *
 * `'unsafe-inline'` in **style-src** — `index.html` carries a `style=` attribute on `<html>`,
 *   the theme preload injects a `<style id="oc-theme-preload">` element, and Solid sets element
 *   styles directly. Style nonces are not reachable for any of the three.
 *
 * ## What this policy is for, and what it is honestly NOT for
 *
 * It bounds **code execution and navigation**, not passive resource loading:
 *   • no script may be loaded from any remote origin (script-src carries no `http:`/`https:`)
 *   • `eval` / `new Function` are refused — verified: the built bundle contains no `new Function(`
 *   • `object-src 'none'` — no plugin/`<embed>` surface
 *   • `base-uri 'none'` — an injected `<base>` cannot re-point every relative URL in the app
 *   • `form-action 'none'` — no form may navigate anywhere (the app has no navigating forms)
 *   • `frame-ancestors 'none'` — the renderer document may never be embedded
 * That matters here because the renderer holds `window.api`, the IPC bridge to the main process.
 *
 * It is NOT an exfiltration control, and claiming otherwise would be ruling 2's "a fault is never
 * described falsely" in reverse. `connect-src` (via `default-src`) permits arbitrary http/https/
 * ws/wss because the UI is a thin client that reaches an instance **by URL**: the built-in
 * sidecar on a random loopback port, a WSL distro's server, and — the shipped remote-access
 * feature (R1–R8) — any peer instance the user types in at runtime, plus its terminal WebSocket.
 * That list changes after the document has loaded, and a CSP cannot. Hardcoding localhost would
 * break remote-instance mode. Passive fetches (img/font/media) are left equally open on purpose:
 * restricting them would protect nothing while silently degrading agent canvases that legitimately
 * draw a remote image.
 */

/**
 * Directives, in serialization order. `default-src` carries the passive/connect surface; every
 * directive that must NOT inherit it is stated explicitly rather than left to CSP's fallback
 * chain, because those chains are where accidents live (`worker-src` falls back to `child-src`
 * then `script-src`, not to `default-src`).
 *
 * `nc:` sits beside `'self'` deliberately. `'self'` should match `nc://renderer` — the scheme is
 * registered `standard: true, secure: true` — but a packaged build cannot be exercised from a
 * dev box, and if `'self'` did NOT match a custom scheme the failure mode is a white window with
 * no way to see it. `nc:` is our own protocol handler with path-traversal containment, so naming
 * it costs nothing and removes an unobservable failure.
 */
export const RENDERER_CSP_DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'", "nc:", "data:", "blob:", "http:", "https:", "ws:", "wss:"],
  "script-src": ["'self'", "nc:", "'unsafe-inline'", "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "nc:", "data:", "blob:", "'unsafe-inline'"],
  "worker-src": ["'self'", "nc:", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
}

export const CSP_HEADER = "Content-Security-Policy"

/** The serialized header value applied to the renderer document in both load modes. */
export const RENDERER_CSP = Object.entries(RENDERER_CSP_DIRECTIVES)
  .map(([name, sources]) => `${name} ${sources.join(" ")}`)
  .join("; ")

/** Parse a serialized policy back into directives — used by the test to assert on real output. */
export function parseCsp(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const directive of policy.split(";")) {
    const [name, ...sources] = directive.trim().split(/\s+/).filter(Boolean)
    if (!name) continue
    out[name.toLowerCase()] = sources
  }
  return out
}
