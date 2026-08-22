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

/**
 * 🔴 THE URL IS PINNED AGAINST THE CONTRACT, not against itself.
 *
 * `agent-file-link.test.ts` asserted `?directory=` and passed, because it was checking `fileUrl`
 * against a copy of `fileUrl`'s own opinion. The live endpoint answered **500**: `LocationQuery` is a
 * deepObject parameter, so the wire spelling is `location[directory]`. A unit test cannot catch that
 * class — the only two things that can are calling the endpoint, and reading the contract that
 * defines it. This does the second on every run.
 */
describe("the file URL matches the endpoint it calls", () => {
  test("the route and its location parameter are the ones the protocol declares", () => {
    const fs = read("protocol", "src", "groups", "fs.ts")
    expect(fs).toContain('"/api/fs/read/*"')
    expect(fs).toContain("LocationQuery")

    const location = read("protocol", "src", "groups", "location.ts")
    // deepObject + explode is what makes the wire form `location[directory]=…` rather than flat.
    expect(location).toMatch(/style:\s*"deepObject"/)
    expect(location).toMatch(/directory:\s*Schema\.optional/)

    const client = read("app", "src", "apps", "agent-file-link.ts")
    expect(client).toContain("/api/fs/read/")
    expect(client).toContain("location%5Bdirectory%5D=")
    // ⚠️ The flat spelling must not come back. It is the natural thing to write and it 500s.
    expect(client).not.toMatch(/\?directory=/)
  })
})

/**
 * 🔴 NO LAZY LOADING ON A CHAT IMAGE — measured live 2026-08-22.
 *
 * The first version emitted `loading="lazy"` and the image NEVER APPEARED. An `<img>` with no
 * intrinsic size lays out 0×0, and a lazy image with zero dimensions is not triggered even when it is
 * squarely in the viewport: `complete` stayed false with the element visible and its URL answering
 * 200 `image/svg+xml`. Setting `eager` on the live element loaded it at 320×120 immediately.
 *
 * Every other check passed throughout — the resolver was called, the `src` was correct, the class was
 * applied. Nothing about a correct `src` makes a browser fetch it, and no unit test in this repo can
 * see that difference. This one keeps the attribute from coming back as an "optimisation".
 */
test("the image renderer does not defer loading", () => {
  const source = read("ui", "src", "context", "marked.tsx")
  const image = source.slice(source.indexOf("image({ href"))
  expect(image).not.toContain('loading="lazy"')
})
