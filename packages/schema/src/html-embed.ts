/**
 * The policy an agent-drawn HTML canvas runs under, and where that document lives.
 *
 * ## Why this is here and not in the surface that renders it
 *
 * There are TWO app policies — `desktop/src/main/csp.ts` for the Electron renderer and
 * `novaclaw/src/server/shared/ui.ts` for the served web UI — and they have never shared a source.
 * That split is the root of both NC-SEC-031 (a missing `frame-src` on one) and NC-SEC-032 (a
 * missing `'unsafe-inline'` on the other, which meant canvases never ran on the web at all). The
 * embed policy is the one thing both surfaces must agree on exactly, so it has exactly one home.
 *
 * ## Why the embed is a DOCUMENT rather than a srcdoc
 *
 * `about:srcdoc`, `data:` and `blob:` all inherit the embedder's policy container — measured, all
 * three. So a canvas is governed by whichever app policy happens to be hosting it, which is how the
 * same feature came to work on desktop and be dead on the web. A network-delivered document does
 * NOT inherit: it carries its own policy in its own response headers. Measured 2026-08-28 in
 * Chromium (Edge 151 over CDP), same-origin and sandboxed, with the child's fetch verified in the
 * server's request log so a silent result could not be a document that never loaded.
 *
 * ⚠️ It does not need a separate ORIGIN, only a separate POLICY. `sandbox` without
 * `allow-same-origin` already forces an opaque origin whatever the URL, so the embed can be served
 * from the app's own origin — which matters because the UI reaches an instance BY URL, and a
 * dynamic embed origin could not be named in a static `frame-src` at all.
 */

/** Where each surface serves the embed bootstrap, relative to the app's own origin. */
export const HTML_EMBED_PATH = "embed.html"

/**
 * True for the one document that must be served with {@link HTML_EMBED_CSP} instead of the app
 * policy.
 *
 * ⚠️ Matches the BASENAME, and is given the file actually being served rather than the requested
 * path. Those are different in the case that matters: the web surface falls back to `index.html`
 * for unknown paths, so a request for `/embed.html` in a build that has no embed document would
 * serve the APP shell — and answering on the request path would hand the app shell a
 * `default-src 'none'` policy, i.e. a white window. Judging the resolved file cannot make that
 * mistake: no embed document, no embed policy.
 *
 * ⚠️ Backslashes are separators too. The desktop resolves these to real Windows paths.
 */
export function isHtmlEmbedDocument(pathOrFile: string) {
  const basename = pathOrFile.split(/[\\/]/).pop() ?? ""
  return basename === HTML_EMBED_PATH
}

/**
 * 🔴 **NC-SEC-003 — the sandbox was never the whole boundary.**
 *
 * Omitting `allow-same-origin` puts the canvas in an opaque origin with no cookies, storage or
 * parent access — all true, and all about what it can READ locally. It says nothing about what it
 * can SEND. `default-src 'none'` closes that: `connect-src` inherits it, so fetch, XHR, WebSocket
 * and beacon are all refused, and `frame-src` inherits it so it cannot navigate itself out either
 * (NC-SEC-031, which the renderer's own `frame-src` also covers from the other side).
 *
 * ⚠️ Inline script and style stay ALLOWED, because that is the whole feature — a throw-away chart
 * is inline by construction, and a policy that broke it would simply be turned off. What is removed
 * is the network, not the ability to draw.
 *
 * ⚠️ `data:` and `blob:` are allowed for images, fonts and media so a canvas can show what it
 * generated itself. Neither can reach a remote host, so neither is an exfiltration channel.
 */
export const HTML_EMBED_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

/** The policy as the meta tag that carries it, for a document that is not served with a header. */
export const htmlEmbedCspMeta = () => `<meta http-equiv="Content-Security-Policy" content="${HTML_EMBED_CSP}">`
