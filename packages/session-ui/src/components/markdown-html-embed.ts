// Fenced blocks tagged `html` render as live sandboxed iframes so agents can emit
// throw-away visualizations (charts, tables, tiny demos) instead of dead source text.
// The embed *decision* lives here, DOM-free, so it stays unit-testable under plain
// `bun test` — markdown.tsx owns the actual iframe construction.

// The sandbox deliberately omits `allow-same-origin`: scripts run in an opaque origin
// with no cookies, storage, or parent access. ⚠️ That is HALF the boundary — it governs
// what a canvas can READ locally and says nothing about what it can SEND. The other half
// is the policy below, which closes the network (NC-SEC-003/031). Together they are what
// makes it safe to execute the raw, never-sanitized fence text.
export const HTML_EMBED_SANDBOX = "allow-scripts"

/**
 * The canvas policy and the meta tag that carries it live in `@novaclaw/schema/html-embed` — the
 * one home both app surfaces can reach. Re-exported here because this module is where the embed is
 * BUILT, and a caller looking for the policy looks here first.
 *
 * ⚠️ Re-exported, never restated. Two app policies with no shared source is the root cause of both
 * NC-SEC-031 and NC-SEC-032; a third copy of the embed policy would be the same mistake again.
 */
import { HTML_EMBED_CSP, htmlEmbedCspMeta } from "@novaclaw/schema/html-embed"

export { HTML_EMBED_CSP, htmlEmbedCspMeta }

// Case-insensitive on purpose: models emit ```HTML / ```Html often enough to matter.
export function htmlEmbedLanguage(language: string | undefined) {
  return language?.toLowerCase() === "html"
}

// A block only embeds once its fence has closed: while the fence is still streaming we
// keep the plain highlighted-code rendering (no iframe churn per token, no half-parsed
// documents) and swap to the live preview exactly once when `complete` flips true.
// Static/historical renders mark every well-formed fence complete, so they embed
// immediately. The returned `html` is the RAW fence body — it intentionally bypasses DOMPurify,
// because the sandbox plus the policy are the security boundary: the sandbox stops it reading
// anything local, the policy stops it SENDING anything out. Callers must only ever hand it to the
// embed document, which writes it into itself, and never parse it into the parent document.
//
// 🔴 NC-SEC-032 — `html`, no longer `srcdoc`. An `about:srcdoc` document INHERITS the embedder's
// policy container, so a canvas was governed by whichever app policy happened to be hosting it.
// That is how this feature came to work on the desktop and be completely dead on the served web
// UI, whose policy carries no `script-src 'unsafe-inline'`. It is delivered to a real served
// document now, which carries its own policy — measured in Chromium, both directions.
export function htmlEmbedForBlock(block: {
  mode: string
  language?: string
  complete?: boolean
  src: string
}): { html: string } | undefined {
  if (block.mode !== "code") return undefined
  if (!htmlEmbedLanguage(block.language)) return undefined
  if (!block.complete) return undefined
  // ⚠️ The policy still LEADS the body, even though the embed document is served with that same
  // policy as a header. Two reasons it is not redundant: policies COMBINE restrictively, so a
  // second copy can only ever narrow; and if a header seam silently stops applying, the canvas
  // stays contained rather than quietly gaining the network. Containment that survives one broken
  // seam is worth more than a failure that announces itself, because what it would announce is
  // exfiltration that already happened.
  //
  // ⚠️ Leading, not trailing: a CSP meta governs only what is parsed AFTER it.
  return { html: `${htmlEmbedCspMeta()}\n${block.src}` }
}
