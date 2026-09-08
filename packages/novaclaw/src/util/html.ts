// Re-export, not a copy. The body lives in `@novaclaw/core/util/html`; the name stays here because
// `skill/index.ts` is a legitimate second caller and this module already carries the test that pins the
// five-character contract. Aliasing rather than re-typing the body means they cannot disagree.
export { escapeHtml } from "@novaclaw/core/util/html"
