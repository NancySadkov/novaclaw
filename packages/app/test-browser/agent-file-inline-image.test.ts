import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { FileContent } from "@novaclaw/sdk/v2"
import { parseWithFileRenderer } from "@novaclaw/ui/context/marked"
import { getCachedMarkdown, preloadMarkdown, sanitizeMarkdown } from "@novaclaw/session-ui/markdown-cache"
import { project } from "@novaclaw/session-ui/markdown-stream"
import { INLINE_MEDIA_LIMIT_CHARS } from "@novaclaw/session-ui/pierre/media"
import { agentFileResolver, forgetAgentFileImages } from "@/apps/agent-file-link"
import { setInstanceBase, setInstanceFileReader, setInstanceMediaNote } from "@/apps/instance-origin"

/**
 * 🔴 **A CHAT IMAGE RENDERS THROUGH THE AUTHENTICATED CLIENT, NOT THROUGH AN ANONYMOUS URL.**
 *
 * The renderer used to put `<instance>/api/fs/read/<name>?location[directory]=…` into an `<img src>`.
 * A browser subresource carries no `Authorization` header and the route's middleware accepts only
 * `Authorization: Basic`, so on any instance with a server password every image a colleague embedded
 * rendered broken. The bytes are now read by the code that HOLDS the credential and pasted in as a
 * `data:` URL — the same mechanism `components/file-media.tsx` already used for the diff viewer.
 *
 * ⚠️ **Two beliefs this file pins because the design that preceded it got both wrong, measured.**
 *
 *  1. **`data:` survives our sanitizer.** DOMPurify strips `blob:` (its `ALLOWED_URI_REGEXP` rejects
 *     it) and admits `data:` on `src` for `img/audio/video/source/track` through a separate branch —
 *     and correctly refuses it on an `<a href>`. One measured row was generalised to the others and
 *     the conclusion was that the renderer was blocked. It is blocked for the download anchor only.
 *  2. **A per-render CREDENTIAL would be dead on the second mount.** The rendered HTML is
 *     content-addressed and replayed verbatim from a 200-entry LRU, so anything with a lifetime —
 *     a single-use ticket, an object URL — works for one paint and then does not. A `data:` URL has
 *     no lifetime and issues no second request, which is why the replay case below is the one worth
 *     owning.
 *
 * ⚠️ Scope is the IMAGE half, and the two halves deliberately take DIFFERENT answers. A
 * `<a download>` is clicked at an arbitrary time after render, and its artefact may be a video or
 * an archive — so it must keep STREAMING and cannot become a `data:` URL. It mints a short-lived
 * ticket at click time instead (`agent-file-download-click.test.ts`); what the non-image assertions
 * below control for here is that a download still reads nothing through this process.
 */

/** A one-pixel-ish payload. Only its base64-ness and its length matter to anything here. */
const PNG = "iVBORw0KGgoAAAANSUhEUg=="
const NOTE = "Image preview unavailable."

let reads: string[] = []

/** Stand in for the instance's authenticated client, and COUNT what it is asked for. */
function serve(content: string, mimeType = "image/png") {
  reads = []
  setInstanceFileReader(async (directory, name): Promise<FileContent> => {
    reads.push(`${directory}/${name}`)
    return { type: "binary", content, encoding: "base64", mimeType }
  })
}

const render = async (markdown: string): Promise<HTMLElement> => {
  const host = document.createElement("div")
  host.innerHTML = await parseWithFileRenderer(markdown, agentFileResolver)
  return host
}

const sanitized = async (markdown: string): Promise<HTMLElement> => {
  const host = document.createElement("div")
  host.innerHTML = sanitizeMarkdown(await parseWithFileRenderer(markdown, agentFileResolver))
  return host
}

/** Every attribute VALUE anywhere in a rendered fragment — the DOM, not the string. */
const attributeValues = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("*")].flatMap((element) => [...element.attributes].map((item) => item.value))

const one = <T extends Element>(host: HTMLElement, selector: string): T => {
  const found = host.querySelector<T>(selector)
  if (!found) throw new Error(`no ${selector} in: ${host.innerHTML}`)
  return found
}

beforeEach(() => {
  forgetAgentFileImages()
  setInstanceBase("http://spark-0693.local:4096")
  setInstanceMediaNote(NOTE)
  serve(PNG)
})

afterEach(() => {
  forgetAgentFileImages()
  setInstanceBase("")
  setInstanceFileReader(undefined)
  setInstanceMediaNote("")
})

describe("a colleague's image reaches the chat without a credential in any URL", () => {
  test("🔴 the src is a data: URL, and NO instance route survives anywhere in the fragment", async () => {
    const host = await render("![chart](/tmp/chart.png)")

    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toBe(`data:image/png;base64,${PNG}`)
    // The negative half, asked of the DOM rather than of the string: not one attribute — src, href,
    // srcset, style, anything — may name the instance or its file route.
    for (const value of attributeValues(host)) {
      expect(value).not.toContain("/api/fs/read")
      expect(value).not.toContain("spark-0693.local")
    }
    // Positive control: the bytes were actually fetched, through the authenticated reader, once.
    expect(reads).toEqual(["/tmp/chart.png"])
  })

  test("an svg is inlined the same way, so the common case a colleague draws works", async () => {
    serve(btoa("<svg xmlns='http://www.w3.org/2000/svg'></svg>"), "image/svg+xml")
    const host = await render("![plot](/tmp/plot.svg)")

    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toStartWith("data:image/svg+xml;base64,")
  })

  // ⚠️ CONTROL. Without it every assertion above is satisfied by a renderer that stopped emitting
  // images at all, and by one that rewrote a web image into nothing.
  test("a web image keeps the author's own src and is never fetched by us", async () => {
    const host = await render("![a](https://e.com/i.png)")

    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toBe("https://e.com/i.png")
    expect(reads).toEqual([])
  })

  /**
   * ⚠️ CONTROL for the half that takes the OTHER answer: a non-image host file is still a download
   * anchor, and it must NOT have started reading bytes through the client. A report, an archive or
   * a video must never have to fit in a JS string, so this path keeps streaming — what changed is
   * that its anchor no longer carries an instance route at all. The route is built at CLICK time,
   * with a ticket, by `apps/agent-file-link.ts`.
   */
  test("a non-image host file is a download anchor that is not fetchable until it is clicked", async () => {
    const host = await render("[report](/tmp/report.pdf)")
    const link = one<HTMLAnchorElement>(host, "a")

    expect(link.getAttribute("href")).toBe("#")
    expect(link.getAttribute("data-agent-file-path")).toBe("/tmp/report.pdf")
    expect(link.getAttribute("download")).toBe("report")
    expect(reads, "a download must not read the bytes through this process").toEqual([])
  })

  /**
   * 🔴 The default that made a rendered image open an SMB connection to an attacker-named host.
   * `//host/share/x.png` is a network destination wearing a path's clothes, and the chat log is
   * where untrusted content gets to choose one. It must not reach the reader at all.
   */
  test("🔴 a path rooted on another machine is never read", async () => {
    const host = await render("![x](//attacker.example/share/x.png)")

    expect(reads, "the credential-holding client was pointed at a UNC path").toEqual([])
    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toBe("//attacker.example/share/x.png")

    // ⚠️ Both rungs, separately. The pre-pass gates on `target`, so `inline`'s own refusal is
    // unreachable through the renderer and would rot unnoticed — it is asked here directly, because
    // the day someone calls `inline` from a second surface is the day it becomes the only guard.
    expect(await agentFileResolver.inline("//attacker.example/share/x.png")).toEqual({
      ok: false,
      reason: "unreadable",
    })
    expect(reads).toEqual([])
  })
})

describe("the sanitizer the product actually runs keeps the inline image", () => {
  test("🔴 data: on an <img src> survives sanitizeMarkdown", async () => {
    const host = await sanitized("![chart](/tmp/chart.png)")

    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toBe(`data:image/png;base64,${PNG}`)
  })

  // ⚠️ CONTROL, and it is the load-bearing half. A sanitizer that had silently become a no-op —
  // `DOMPurify.isSupported` false in this harness, say — would satisfy the assertion above while
  // proving nothing about the product.
  test("the sanitizer is really running: a handler is stripped and blob: is refused", () => {
    expect(sanitizeMarkdown('<img src="data:image/png;base64,AAA" onerror="alert(1)">')).not.toContain("onerror")
    // The row the superseded design generalised FROM. `blob:` is rejected by DOMPurify's
    // ALLOWED_URI_REGEXP; `data:` is admitted by a separate branch. Keeping both here is what stops
    // the conclusion "the renderer is blocked" from being re-derived off one measurement.
    expect(sanitizeMarkdown('<img src="blob:http://localhost/9c1-abc" alt="a">')).not.toContain("blob:")
    expect(sanitizeMarkdown('<img src="data:image/png;base64,AAA" alt="a">')).toContain("data:image/png")
  })
})

/**
 * 🔴 **THE SECOND MOUNT — the case a ticket would have failed.**
 *
 * `markdown.tsx` writes each rendered block into the LRU in `markdown-cache.tsx` and, on a later
 * mount with the same raw text, injects the CACHED string verbatim without parsing again. So
 * whatever credential a parse embedded is being replayed long after it was minted, and
 * `handlers/fs.ts` sets no cache headers, so the browser re-requests. A `data:` URL is the one form
 * with nothing to expire and nothing to re-request.
 */
describe("the rendered image replays from the markdown cache", () => {
  test("🔴 a second mount renders the same picture, with no second read", async () => {
    const source = "![chart](/tmp/chart.png)"
    const parser = { parse: (text: string) => parseWithFileRenderer(text, agentFileResolver) }
    const key = "session-msg-1"
    const blocks = project(undefined, source, false).blocks
    const cacheKey = `${key}:0:${blocks[0]?.mode}`

    await preloadMarkdown(source, key, parser)
    const cached = getCachedMarkdown(cacheKey)
    if (!cached) throw new Error(`nothing cached under ${cacheKey}`)
    expect(reads.length).toBe(1)

    // The second mount: no parser, no resolver, no network — the string the cache holds, injected.
    const host = document.createElement("div")
    host.innerHTML = cached.html

    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toBe(`data:image/png;base64,${PNG}`)
    expect(reads.length, "the replayed HTML needed a fresh read, so it carries something perishable").toBe(1)
    for (const value of attributeValues(host)) expect(value).not.toContain("/api/fs/read")
  })
})

describe("one file is read once, however many times the block is re-parsed", () => {
  test("🔴 N parses of the same image cause exactly one read", async () => {
    const source = "![chart](/tmp/chart.png)"
    // Concurrently, as a streaming message re-parses: the memo stores the PROMISE, so overlapping
    // parses join the first read instead of starting four.
    await Promise.all([render(source), render(source), render(source)])
    await render(source)

    expect(reads.length).toBe(1)
  })

  // ⚠️ CONTROL. Without it "one read" is equally satisfied by a memo that never expires, by a
  // reader that is never called, and by a counter that cannot increment.
  test("the counter can move: forgetting the memo makes the next parse read again", async () => {
    const source = "![chart](/tmp/chart.png)"
    await render(source)
    expect(reads.length).toBe(1)

    forgetAgentFileImages()
    await render(source)
    expect(reads.length).toBe(2)
  })

  test("a different file is a different key", async () => {
    await render("![a](/tmp/a.png)")
    await render("![b](/tmp/b.png)")

    expect(reads).toEqual(["/tmp/a.png", "/tmp/b.png"])
  })

  test("the same name in a different directory is a different key", async () => {
    await render("![a](/tmp/one/chart.png)")
    await render("![a](/tmp/two/chart.png)")

    expect(reads).toEqual(["/tmp/one/chart.png", "/tmp/two/chart.png"])
  })
})

/**
 * 🔴 **THE SIZE CAP, and what "honest" means when it fires.**
 *
 * The data URL goes inside a string the 200-entry LRU keeps, so there is a limit
 * (`INLINE_MEDIA_LIMIT_CHARS`, and the reason for the number is written where it is defined). What
 * there must not be is a broken image or a silent hole: the oversized case degrades to the download
 * link the file would have had if it were not an image, keeps the alt text as its label, and says
 * in words that the preview is unavailable.
 */
describe("an image too large to inline degrades honestly", () => {
  test("🔴 the oversized case renders a named, labelled download link and no image", async () => {
    serve("A".repeat(INLINE_MEDIA_LIMIT_CHARS + 1))
    const host = await render("![chart](/tmp/huge.png)")

    expect(host.querySelector("img"), "a broken image is exactly what must not happen").toBeNull()
    const link = one<HTMLAnchorElement>(host, "a")
    expect(link.getAttribute("data-agent-file-inline")).toBe("oversize")
    expect(link.getAttribute("download")).toBe("huge.png")
    // 🔴 The degrade hands over the same click-time download the link renderer does — not a
    // pre-built instance route, which is what answered 401 under a server password.
    expect(link.getAttribute("href")).toBe("#")
    expect(link.getAttribute("data-agent-file-path")).toBe("/tmp/huge.png")
    expect(link.textContent, "the colleague's own label for the image was dropped").toBe("chart")
    expect(host.textContent, "nothing on screen says why the picture is missing").toContain(NOTE)
  })

  test("the honest degrade survives the sanitizer too", async () => {
    serve("A".repeat(INLINE_MEDIA_LIMIT_CHARS + 1))
    const host = await sanitized("![chart](/tmp/huge.png)")

    expect(one<HTMLAnchorElement>(host, "a").getAttribute("data-agent-file-inline")).toBe("oversize")
    expect(host.textContent).toContain(NOTE)
  })

  test("an unreadable answer degrades the same way, under its own name", async () => {
    setInstanceFileReader(async () => undefined)
    const host = await render("![chart](/tmp/gone.png)")

    expect(one<HTMLAnchorElement>(host, "a").getAttribute("data-agent-file-inline")).toBe("unreadable")
  })

  test("a nameless image falls back to the file's own name as its label", async () => {
    serve("A".repeat(INLINE_MEDIA_LIMIT_CHARS + 1))
    const host = await render("![](/tmp/huge.png)")

    expect(one<HTMLAnchorElement>(host, "a").textContent).toBe("huge.png")
  })

  // ⚠️ CONTROL. Without it the cap assertions pass on a renderer that degraded EVERYTHING, which is
  // the failure the cap is most likely to cause.
  test("a file just under the limit still inlines", async () => {
    // The data URL is `data:image/png;base64,` + the content, so the payload is sized against the
    // limit minus that prefix rather than against the limit itself.
    serve("A".repeat(INLINE_MEDIA_LIMIT_CHARS - 100))
    const host = await render("![chart](/tmp/big.png)")

    expect(host.querySelector("a")).toBeNull()
    expect(one<HTMLImageElement>(host, "img").getAttribute("src")).toStartWith("data:image/png;base64,AAAA")
  })
})
