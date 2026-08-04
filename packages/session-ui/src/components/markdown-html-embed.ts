// Fenced blocks tagged `html` render as live sandboxed iframes so agents can emit
// throw-away visualizations (charts, tables, tiny demos) instead of dead source text.
// The embed *decision* lives here, DOM-free, so it stays unit-testable under plain
// `bun test` — markdown.tsx owns the actual iframe construction.

// The sandbox deliberately omits `allow-same-origin`: scripts run in an opaque origin
// with no cookies, storage, or parent access. That sandbox — not DOMPurify — is the
// entire security boundary that makes it safe to execute the raw fence text.
export const HTML_EMBED_SANDBOX = "allow-scripts"

// Case-insensitive on purpose: models emit ```HTML / ```Html often enough to matter.
export function htmlEmbedLanguage(language: string | undefined) {
  return language?.toLowerCase() === "html"
}

// A block only embeds once its fence has closed: while the fence is still streaming we
// keep the plain highlighted-code rendering (no iframe churn per token, no half-parsed
// documents) and swap to the live preview exactly once when `complete` flips true.
// Static/historical renders mark every well-formed fence complete, so they embed
// immediately. The returned srcdoc is the RAW fence body — it intentionally bypasses
// DOMPurify because the sandboxed iframe is the security boundary. Callers must only
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
  return { srcdoc: block.src }
}
