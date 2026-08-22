import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * THE RENDERER ACTUALLY ASKS — the join, not the rule.
 *
 * 🔴 `agent-file-link.test.ts` proves which hrefs are host files and what URL serves them. It says
 * nothing about whether anything CALLS that: the resolver lives in `packages/app`, the renderer in
 * `packages/ui`, and the wiring in `app.tsx`. All three were right and unconnected at least once this
 * session in other features, so the connection is asserted rather than assumed.
 *
 * ⚠️ Comments stripped first — all three files document this at length, and a regex over raw source
 * would pass on the prose describing code that had been deleted.
 */

const read = (...segments: string[]): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(path.join(here, "..", "..", "..", ...segments), "utf8")
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

describe("a colleague's file reaches the chat", () => {
  test("1. the app hands the renderer a resolver", () => {
    const source = read("app", "src", "app.tsx")
    expect(source).toMatch(/<MarkedProvider\s+resolveFile=\{resolveAgentFile\}/)
  })

  test("2. the link renderer asks it, and marks the result as a download", () => {
    const source = read("ui", "src", "context", "marked.tsx")
    const link = source.slice(source.indexOf("link({ href"), source.indexOf("image({ href"))
    expect(link).toMatch(/resolveFile\?\.\(href\)/)
    // `download` is what makes the click SAVE rather than navigate. Without it the browser renders
    // the bytes in place and the user has a chart where their chat used to be.
    expect(link).toContain("download=")
  })

  test("3. the image renderer inlines a host image", () => {
    const source = read("ui", "src", "context", "marked.tsx")
    const image = source.slice(source.indexOf("image({ href"))
    expect(image).toMatch(/resolveFile\?\.\(href\)/)
  })

  test("🔴 a REMOTE image is left alone — no egress the user did not ask for", () => {
    // The resolver returns undefined for a web URL, and the image renderer must then keep the
    // author's own src. Rewriting it would make the chat fetch from wherever a model named.
    const source = read("ui", "src", "context", "marked.tsx")
    const image = source.slice(source.indexOf("image({ href"))
    expect(image).toMatch(/local\?\.image \? local\.url : href/)
  })

  test("the model's path is escaped before it becomes an attribute", () => {
    // It is untrusted input landing in an HTML string.
    const source = read("ui", "src", "context", "marked.tsx")
    expect(source).toContain("escapeAttribute")
  })
})
