// Fenced blocks tagged `html` render as live sandboxed iframes so agents can emit
// throw-away visualizations (charts, tables, tiny demos) instead of dead source text.
// The embed *decision* lives here, DOM-free, so it stays unit-testable under plain
// `bun test` — markdown.tsx owns the actual iframe construction.

// The sandbox deliberately omits `allow-same-origin`: scripts run in an opaque origin
// with no cookies, storage, or parent access. That sandbox — not DOMPurify — is the
// entire security boundary that makes it safe to execute the raw fence text.
export const HTML_EMBED_SANDBOX = "allow-scripts"

/**
 * 🔴 **NC-SEC-003 — the sandbox was never the whole boundary, and the comment above said it was.**
 *
 * Omitting `allow-same-origin` puts the script in an opaque origin with no cookies, storage or parent
 * access — all true, and all about what it can READ locally. It says nothing about what it can SEND.
 * A canvas could `fetch()` any host, or simply set `img.src` to one, and the transcript text the
 * agent had just been given would leave the machine. On an instance the user has put in airgap mode
 * that is the promise broken by the one surface that renders untrusted output by default.
 *
 * `default-src 'none'` closes egress: no fetch, no XHR, no WebSocket, no beacon, no remote image,
 * script, font or stylesheet. `connect-src` inherits the `'none'`, which is the clause that matters.
 *
 * ⚠️ Inline script and style stay ALLOWED, because that is the whole feature — a throw-away chart or
 * demo is inline by construction, and a policy that broke it would simply be turned off. What is
 * removed is the network, not the ability to draw.
 *
 * ⚠️ `data:` and `blob:` are allowed for images, fonts and media so a canvas can still show what it
 * generated itself. Neither can reach a remote host, so neither is an exfiltration channel.
 *
 * ⚠️ Prepended rather than merged. CSPs COMBINE restrictively — if the agent's own HTML carries a
 * policy, both apply and the strictest wins — so a canvas cannot widen this by declaring its own.
 */
export const HTML_EMBED_CSP =
  "default-src 'none'; img-src data: blob:; media-src data: blob:; font-src data:; " +
  "style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action 'none'; base-uri 'none'"

/** The policy as the meta tag that carries it, ready to lead the document. */
export const htmlEmbedCspMeta = () => `<meta http-equiv="Content-Security-Policy" content="${HTML_EMBED_CSP}">`

// Case-insensitive on purpose: models emit ```HTML / ```Html often enough to matter.
export function htmlEmbedLanguage(language: string | undefined) {
  return language?.toLowerCase() === "html"
}

// A block only embeds once its fence has closed: while the fence is still streaming we
// keep the plain highlighted-code rendering (no iframe churn per token, no half-parsed
// documents) and swap to the live preview exactly once when `complete` flips true.
// Static/historical renders mark every well-formed fence complete, so they embed
// immediately. The returned srcdoc is the RAW fence body — it intentionally bypasses
// DOMPurify because the sandbox plus the CSP above are the security boundary — the sandbox stops it
// reading anything local, the CSP stops it SENDING anything out. Callers must only
// ever assign it to `iframe.srcdoc` (property/attribute assignment), never parse it
// into the parent document.
export function htmlEmbedForBlock(block: {
  mode: string
  language?: string
  complete?: boolean
  src: string
}): { srcdoc: string } | undefined {
  if (block.mode !== "code") return undefined
  if (!htmlEmbedLanguage(block.language)) return undefined
  if (!block.complete) return undefined
  // ⚠️ The policy leads the document. A CSP meta only governs what is parsed AFTER it, so prepending
  // is not a style choice — appending it would leave every resource above it ungoverned.
  return { srcdoc: `${htmlEmbedCspMeta()}\n${block.src}` }
}
