import { expect, test } from "bun:test"
import { HTML_EMBED_CSP, HTML_EMBED_PATH, htmlEmbedCspMeta, isHtmlEmbedDocument } from "./html-embed"

test("🔴 the policy closes the network and leaves the drawing alone", () => {
  // Both halves, because either one alone is a policy nobody would keep: no egress, but a canvas
  // that cannot run is a feature that gets turned off.
  expect(HTML_EMBED_CSP).toContain("default-src 'none'")
  expect(HTML_EMBED_CSP).toContain("script-src 'unsafe-inline'")
  expect(HTML_EMBED_CSP).toContain("style-src 'unsafe-inline'")
  expect(HTML_EMBED_CSP).toContain("img-src data: blob:")
})

test("no remote origin appears anywhere in the policy", () => {
  // The control: every assertion above also passes on a policy that ALSO allows https:.
  for (const remote of ["https:", "http:", "*", "ws:", "wss:"]) {
    expect(HTML_EMBED_CSP).not.toContain(remote)
  }
})

test("the embed document is recognised however its path is spelled", () => {
  expect(isHtmlEmbedDocument("embed.html")).toBe(true)
  expect(isHtmlEmbedDocument("/embed.html")).toBe(true)
  // It is handed the RESOLVED file, which on the desktop is a real Windows path.
  expect(isHtmlEmbedDocument("C:\\dist\\renderer\\embed.html")).toBe(true)
  expect(isHtmlEmbedDocument("/opt/novaclaw/web/embed.html")).toBe(true)
})

test("🔴 nothing else gets the embed policy, above all not the app shell", () => {
  // ⚠️ The dangerous direction. `default-src 'none'` on `index.html` is a white window with no
  // console to see it in — the web surface falls back to the app shell for unknown paths, so a
  // predicate judging the REQUEST would answer true for `/embed.html` in a build that has no embed
  // document and hand that fallback this policy.
  expect(isHtmlEmbedDocument("index.html")).toBe(false)
  expect(isHtmlEmbedDocument("/index.html")).toBe(false)
  // Not a suffix test either.
  expect(isHtmlEmbedDocument("/assets/not-embed.html")).toBe(false)
  expect(isHtmlEmbedDocument("/embed.html.map")).toBe(false)
  expect(isHtmlEmbedDocument("")).toBe(false)
})

test("the meta tag carries the same policy as the header", () => {
  expect(htmlEmbedCspMeta()).toBe(`<meta http-equiv="Content-Security-Policy" content="${HTML_EMBED_CSP}">`)
})

test("the path is a bare relative name", () => {
  // It resolves against whichever origin the app is on — `nc://renderer/` or the instance server —
  // which is the whole reason no dynamic origin has to be expressed in any frame-src.
  expect(HTML_EMBED_PATH).toBe("embed.html")
  expect(HTML_EMBED_PATH.startsWith("/")).toBe(false)
})
