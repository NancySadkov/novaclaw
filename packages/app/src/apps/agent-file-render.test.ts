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

/**
 * ⚠️ **A block comment is only stripped when it OPENS A LINE, and that is not fussiness.**
 *
 * The route this file's last describe asserts is `"/api/fs/read/*"` — a wildcard path whose final
 * two characters are `/*`. The stripper used to match `/\*[\s\S]*?\*\//` anywhere, so the moment a
 * doc comment was added anywhere BELOW that route the two paired up and ate every line between
 * them: the assertion failed naming a route that was still there, three lines from where it always
 * was. Requiring the opener to start its own line separates a JSDoc from a path, and every block
 * comment in the files read here is a JSDoc.
 */
const read = (...segments: string[]): string => {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const raw = readFileSync(path.join(here, "..", "..", "..", ...segments), "utf8")
  return raw.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "").replace(/(^|[^:])\/\/.*$/gm, "$1")
}

const IMAGE_RENDERER = "image(token: Tokens.Image"

describe("a colleague's file reaches the chat", () => {
  test("1. the app hands the renderer a resolver", () => {
    const source = read("app", "src", "app.tsx")
    expect(source).toMatch(/<MarkedProvider\s+resolveFile=\{agentFileResolver\}/)
  })

  test("2. the link renderer asks it, and marks the result as a download", () => {
    const source = read("ui", "src", "context", "marked.tsx")
    const link = source.slice(source.indexOf("link({ href"), source.indexOf(IMAGE_RENDERER))
    expect(link).toMatch(/resolveFile\?\.target\(href\)/)
    // `download` is what makes the click SAVE rather than navigate. Without it the browser renders
    // the bytes in place and the user has a chart where their chat used to be.
    //
    // ⚠️ Matched on the attribute NAME, not on the literal `download=`. The renderers no longer
    // write `name="` at all — every attribute is emitted whole by the escaping helper, which is
    // exactly what stops one of them being interpolated raw — so `download=` appears nowhere in the
    // link renderer even though the attribute is very much still emitted.
    expect(link).toMatch(/(flagAttr|attr)\("download",/)
  })

  test("3. the image renderer inlines a host image from the PRE-PASS, never from a url", () => {
    const source = read("ui", "src", "context", "marked.tsx")
    const image = source.slice(source.indexOf(IMAGE_RENDERER))
    expect(image).toMatch(/resolveFile\?\.target\(href\)/)
    // 🔴 The src of a host image comes off the token the async pass stashed it on. `local.url` is a
    // download route and must not reappear in an `<img>`: a subresource carries no credential, so a
    // route there answers 401 on any instance with a server password.
    expect(image).toMatch(/attr\("src", inlined\.src\)/)
    expect(image.slice(0, image.indexOf("const anchor ="))).not.toContain('attr("src", local.url)')
  })

  test("🔴 a REMOTE image is left alone — no egress the user did not ask for", () => {
    // The resolver returns undefined for a web URL, and the image renderer must then keep the
    // author's own src. Rewriting it would make the chat fetch from wherever a model named.
    const source = read("ui", "src", "context", "marked.tsx")
    const image = source.slice(source.indexOf(IMAGE_RENDERER))
    expect(image).toMatch(/if \(!local\?\.image\)\s*\n?\s*return `<img\$\{attr\("src", href\)\}/)
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
  const image = source.slice(source.indexOf(IMAGE_RENDERER))
  expect(image).not.toContain('loading="lazy"')
})

/**
 * 🔴 NO SECOND PARSER, so there is no parser that skips `fileRenderer`.
 *
 * The context used to return a host-supplied `nativeParser` when one was passed — a path that
 * applied neither the file renderer nor the maths extension, so a colleague's file links and every
 * formula would have vanished for whoever wired it. It had zero suppliers and had never run, so the
 * close is that it no longer exists rather than that it is documented.
 */
test("there is exactly one parser, and the file renderer is on it", () => {
  const source = read("ui", "src", "context", "marked.tsx")
  expect(source).not.toContain("nativeParser")
  expect(source.match(/marked\.use\(|new Marked\(/g)?.length).toBe(2)
})

/**
 * 🔴 THE DOWNLOAD CLICK IS ALSO A JOIN, and it spans one more package than the render does.
 *
 * `marked.tsx` emits the hook, `session-ui/components/markdown.tsx` installs the delegated listener,
 * `markdown-agent-file.ts` claims the click, and `app/src/apps/agent-file-link.ts` mints the ticket
 * and saves the file. `app/test-browser/agent-file-download-click.test.ts` drives the last three
 * against real rendered markup; the one link it cannot reach is the FIRST — `markdown.tsx` imports
 * a bundler-only `?worker&url` module, so `bun test` cannot load it into a DOM at all. That line is
 * asserted here instead, which is the same reason every other test in this file exists.
 */
describe("a colleague's file is SAVED by a click, not by an href", () => {
  test("the renderer emits no instance URL — the anchor's own href is inert", () => {
    const source = read("ui", "src", "context", "marked.tsx")
    // The member the renderers used to interpolate is gone from the type, so neither branch can
    // name it. Both anchors carry `href="#"` and the path in a data attribute instead.
    expect(source).not.toContain("local.url")
    expect(source.match(/class="agent-file-link"/g)?.length).toBe(2)
    expect(source.match(/<a href="#"/g)?.length).toBe(2)
    expect(source).toContain("AGENT_FILE_PATH_ATTRIBUTE")
  })

  /**
   * 🔴 **The one line no behavioural test in this repo can reach, and it was measured.**
   *
   * `markdown.tsx` imports the highlighting worker through a bundler-only `?worker&url` specifier,
   * so `bun test` cannot load that module into a DOM at all — which means the DOM suite has to call
   * the handler itself. Poisoning this exact statement to `if (false && …)` was run against the
   * whole `app:browser` directory and produced **222 pass / 0 fail**: without the assertion below,
   * a colleague's file link would render, look right, and do nothing on click, and every other test
   * in this change would still be green.
   *
   * ⚠️ So the CALL is pinned, not the identifier. `toContain("handleAgentFileClick")` was the first
   * version and it is what the poison walked straight past.
   */
  test("the markdown component installs the delegated handler", () => {
    const source = read("session-ui", "src", "components", "markdown.tsx")
    expect(source).toContain("if (handleAgentFileClick(event, getFileResolver)) return")
    // ⚠️ Inside the delegated `click` listener, not on a per-anchor binding: the chat rewrites its
    // own HTML on every streamed token, and a listener attached to an element does not survive that.
    expect(source).toMatch(/root\.addEventListener\("click"/)
    // And the resolver it hands over must be the LIVE one — a captured value points at whichever
    // instance was connected when the component mounted.
    expect(source).toContain("() => marked.resolveFile()")
  })

  test("the app answers that click by minting a ticket, never by pasting a credential", () => {
    const source = read("app", "src", "apps", "agent-file-link.ts")
    expect(source).toContain("download: (href) => downloadHostFile(href)")
    expect(source).toContain("instanceTicketMinter()")
    // 🔴 `auth_token` is `btoa("user:password")` and `workspaceProxyURL` copies a query string
    // wholesale into a proxy target. A ticket names one file, works once, and expires in a minute.
    expect(source).not.toContain("auth_token")
  })

  test("the Files browser reaches the same click, and has no href to leak", () => {
    const source = read("app", "src", "pages", "files.tsx")
    expect(source).toContain("downloadHostPath(entry().absolute)")
    expect(source).not.toContain("fileDownloadHref")
    expect(source).toContain('data-action="download-file"')
  })
})
