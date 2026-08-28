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

  test("embeds a completed html code block with the fence body UNALTERED, led by the policy", () => {
    const embed = htmlEmbedForBlock({
      mode: "code",
      language: "html",
      complete: true,
      src: "<h1>hi</h1>\n<script>1</script>",
    })
    // The body is still verbatim — never sanitized, never rewritten. That is the contract the
    // sandbox exists to make safe.
    expect(embed?.html).toContain("<h1>hi</h1>\n<script>1</script>")
    // ...and the policy leads it (NC-SEC-003).
    expect(embed?.html.startsWith('<meta http-equiv="Content-Security-Policy"')).toBe(true)
  })

  /**
   * 🔴 NC-SEC-003 — the sandbox was never the whole boundary, though the code said it was. Omitting
   * `allow-same-origin` is about what a canvas can READ locally; it says nothing about what it can
   * SEND. A canvas could `fetch()` any host, or just set `img.src`, and the transcript text the agent
   * had been given would leave the machine — on an airgapped instance too.
   *
   * A/B: drop the prepend in `htmlEmbedForBlock` and both of these fail.
   */
  test("🔴 the policy closes the NETWORK while leaving the drawing alone", () => {
    const embed = htmlEmbedForBlock({ mode: "code", language: "html", complete: true, src: "<p>x</p>" })
    const body = embed?.html ?? ""
    // No egress: `connect-src` inherits `default-src 'none'`, which is the clause that matters —
    // fetch, XHR, WebSocket and beacon all fall under it.
    expect(body).toContain("default-src 'none'")
    // The feature still works: a throw-away chart is inline by construction, and a policy that broke
    // it would simply be turned off.
    expect(body).toContain("script-src 'unsafe-inline'")
    expect(body).toContain("style-src 'unsafe-inline'")
    // Self-generated pictures still render; neither scheme can reach a remote host.
    expect(body).toContain("img-src data: blob:")
  })

  test("no remote origin is allowed anywhere in the policy", () => {
    // The control: the assertions above would all pass on a policy that ALSO allowed `https:`.
    const embed = htmlEmbedForBlock({ mode: "code", language: "html", complete: true, src: "<p>x</p>" })
    const policy = (embed?.html ?? "").split("\n")[0] ?? ""
    expect(policy).not.toContain("https:")
    expect(policy).not.toContain("http:")
    expect(policy).not.toContain("*")
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
    // The body arrives unaltered; the policy leads it (NC-SEC-003).
    expect(htmlEmbedForBlock(closed)?.html).toContain("<div>done</div>")
  })

  test("static html fences embed immediately with the fence body extracted", () => {
    const block = stream('```html\n<canvas id="c"></canvas>\n```', false).at(-1)!
    expect(htmlEmbedForBlock(block)?.html).toContain('<canvas id="c"></canvas>')
  })
})
