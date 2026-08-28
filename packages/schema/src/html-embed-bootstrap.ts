/**
 * The document an agent canvas actually runs in, and the two-message protocol that fills it.
 *
 * A canvas cannot be delivered as `srcdoc` any more: `about:srcdoc`, `data:` and `blob:` all
 * inherit the embedder's policy container, so the canvas ends up governed by whichever app policy
 * is hosting it — which is how the same feature came to work on desktop and be dead on the web
 * (NC-SEC-032). A network-delivered document carries its own policy, so the canvas is served as a
 * real document and the fence body is posted IN.
 *
 * ## The protocol, and why it needs two messages
 *
 * The frame is created empty and navigates asynchronously, so the parent cannot simply post on the
 * next line — there is no document to receive it yet. The bootstrap therefore announces itself
 * ({@link EMBED_READY}) and the parent replies with the body ({@link EMBED_WRITE}). A parent that
 * has the body before the announcement holds it and sends on arrival.
 */

/** Sent by the bootstrap to its embedder once it can receive a body. */
export const EMBED_READY = "novaclaw:canvas-ready"

/** Sent by the embedder, carrying the fence body verbatim. */
export const EMBED_WRITE = "novaclaw:canvas-write"

export type EmbedMessage =
  | { readonly type: typeof EMBED_READY }
  | { readonly type: typeof EMBED_WRITE; readonly html: string }

/**
 * Is this a genuine ready announcement from the frame we are embedding?
 *
 * ⚠️ Identity of the sending window, not its origin. The frame is sandboxed without
 * `allow-same-origin`, so it posts from an opaque origin and `event.origin` is the string "null"
 * for every such frame in the page — it cannot distinguish ours from anyone's. A window reference
 * cannot be forged by a third party, so that is what the check uses.
 */
export function isEmbedReady(data: unknown, source: unknown, frame: unknown): boolean {
  if (source !== frame || frame === null || frame === undefined) return false
  return typeof data === "object" && data !== null && (data as { type?: unknown }).type === EMBED_READY
}

/**
 * The bootstrap document, as served at `HTML_EMBED_PATH` on BOTH surfaces.
 *
 * ⚠️ This module imports NOTHING, deliberately. It is pulled in by `packages/app/vite.js`, and a
 * vite config is loaded through Node's ESM resolver rather than the bundler — which cannot resolve
 * an extensionless `./sibling` inside a `.ts` file. A cross-import here does not fail a typecheck
 * or a test; it fails the dev server at startup, which is how it was found.
 *
 * ⚠️ It carries no policy of its own. The policy arrives as a response header — that is the entire
 * reason this is a served document rather than a srcdoc, and a `<meta>` here would only be a second
 * copy to drift.
 *
 * ⚠️ It writes ONCE. `document.open()` tears down the document that registered the listener, so a
 * second body is delivered by the parent RE-NAVIGATING the frame, not by posting again. That
 * matches how the renderer already behaves: it leaves a canvas alone unless the fence body changed,
 * and rebuilds it when it did.
 */
export function htmlEmbedBootstrap(): string {
  return `<!doctype html>
<meta charset="utf-8">
<title>canvas</title>
<style>html,body{margin:0;height:100%;font:14px/1.5 system-ui,sans-serif}</style>
<script>
(function () {
  function receive(event) {
    // Only our own embedder may write here. Identity, not origin: this frame is sandboxed into an
    // opaque origin, so every such frame reports "null" and origin cannot tell them apart.
    if (event.source !== window.parent) return
    var message = event.data
    if (!message || message.type !== ${JSON.stringify(EMBED_WRITE)} || typeof message.html !== "string") return
    window.removeEventListener("message", receive)
    document.open()
    document.write(message.html)
    document.close()
  }
  window.addEventListener("message", receive)
  window.parent.postMessage({ type: ${JSON.stringify(EMBED_READY)} }, "*")
})()
</script>`
}
