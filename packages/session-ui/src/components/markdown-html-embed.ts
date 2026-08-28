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
