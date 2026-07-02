import { describe, expect, test } from "bun:test"
import { HTML_EMBED_SANDBOX, htmlEmbedForBlock, htmlEmbedLanguage } from "./markdown-html-embed"
import { stream } from "./markdown-stream"

describe("markdown html embed", () => {
  test("keeps the sandbox scripts-only (no allow-same-origin, ever)", () => {
    expect(HTML_EMBED_SANDBOX).toBe("allow-scripts")
  })

  test("matches the html language case-insensitively", () => {
    expect(htmlEmbedLanguage("html")).toBe(true)
    expect(htmlEmbedLanguage("HTML")).toBe(true)
    expect(htmlEmbedLanguage("htm")).toBe(false)
    expect(htmlEmbedLanguage("ts")).toBe(false)
    expect(htmlEmbedLanguage(undefined)).toBe(false)
  })

  test("embeds a completed html code block with the verbatim fence body as srcdoc", () => {
    expect(
      htmlEmbedForBlock({ mode: "code", language: "html", complete: true, src: "<h1>hi</h1>\n<script>1</script>" }),
    ).toEqual({ srcdoc: "<h1>hi</h1>\n<script>1</script>" })
  })

  test("never embeds unclosed fences, other languages, or non-code blocks", () => {
    expect(htmlEmbedForBlock({ mode: "code", language: "html", complete: false, src: "<h1>hi" })).toBeUndefined()
    expect(htmlEmbedForBlock({ mode: "code", language: "html", src: "<h1>hi" })).toBeUndefined()
    expect(htmlEmbedForBlock({ mode: "code", language: "ts", complete: true, src: "const x = 1" })).toBeUndefined()
    expect(htmlEmbedForBlock({ mode: "full", language: "html", complete: true, src: "<h1>hi</h1>" })).toBeUndefined()
  })

  test("streamed html fences only become embeddable once the fence closes", () => {
    const open = stream("```html\n<div>partial", true).at(-1)!
    expect(open.mode).toBe("code")
    expect(htmlEmbedForBlock(open)).toBeUndefined()

    const closed = stream("```html\n<div>done</div>\n```", true).at(-1)!
    expect(htmlEmbedForBlock(closed)).toEqual({ srcdoc: "<div>done</div>" })
  })

  test("static html fences embed immediately with the fence body extracted", () => {
    const block = stream("```html\n<canvas id=\"c\"></canvas>\n```", false).at(-1)!
    expect(htmlEmbedForBlock(block)).toEqual({ srcdoc: '<canvas id="c"></canvas>' })
  })
})
