/**
 * Resolve a `packages/app/public/` asset against the page's RUNTIME base, not the origin root.
 *
 * A literal `src="/logo.png"` resolves to the origin root, which is only correct when the app is
 * served at `/`. It is not: the remote-access surface serves a session under
 * `/server/{base64(url)}/session/{id}`, and the Electron renderer loads from a custom `nc://`
 * protocol — in both, an origin-rooted path points at nothing and the asset silently fails to load.
 *
 * `import.meta.env.BASE_URL` is Vite's build-time base; `document.baseURI` picks up a runtime
 * `<base href>`. Resolving through both means one helper covers dev, the web build under a path
 * prefix, and the packaged renderer.
 *
 * Ported from NancySadkov/novaclaw#3 by @DassaultFalconKing.
 */
export function publicAssetUrl(path: string, base = import.meta.env.BASE_URL, documentUrl = document.baseURI) {
  return new URL(path.replace(/^\/+/, ""), new URL(base, documentUrl)).href
}
