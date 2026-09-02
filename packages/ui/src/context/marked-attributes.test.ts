import { describe, expect, test } from "bun:test"
import { marked } from "marked"
import { fileRenderer } from "./marked"

/**
 * 🔴 **Attribute escaping in the link and image renderers, driven through the REAL parser.**
 *
 * These renderers build HTML by string interpolation from values marked hands them, and marked's
 * source is a colleague's message — the most untrusted content in the product. So escaping here is a
 * security property, not tidiness.
 *
 * ⚠️ **It had already gone wrong once**: `image` escaped its `title` while `link`, twenty-five lines
 * above it in the same object literal, interpolated it raw. Nothing caught that, because nothing
 * drove these renderers at all — they were closed over the context's `init`. They are now a
 * factory so this file can reach them.
 *
 * ⚠️ **DOMPurify downstream is not the reason to skip this.** It runs in another package, one place
 * in this subsystem deliberately bypasses it (`markdown-html-embed.ts`), and a sanitizer config is a
 * thing people edit. An HTML string built from model output should be correct where it is built.
 */

const render = (source: string): string =>
  marked.use({ renderer: fileRenderer() }).parse(source, { async: false }) as string

/** The payload: a title that closes its own attribute and opens an event handler. */
const BREAKOUT = '[x](https://e.com "a\\" onmouseover=\\"alert(1)")'

describe("link and image attributes are escaped at the point they are built", () => {
  test("🔴 a link title cannot close its attribute and add a handler", () => {
    const out = render(BREAKOUT)
    // The proof is negative AND positive: no live handler, and the payload still present as text.
    expect(out, "the title broke out of its attribute — this is an injected event handler").not.toContain(
      'onmouseover="alert(1)"',
    )
    expect(out, "the payload vanished entirely, so this test is not exercising what it claims").toContain("&quot;")
  })

  test("🔴 an image title cannot either", () => {
    const out = render('![x](https://e.com/i.png "a\\" onerror=\\"alert(1)")')
    expect(out).not.toContain('onerror="alert(1)"')
    expect(out).toContain("&quot;")
  })

  test("an image's alt text is escaped too", () => {
    const out = render('![a" onerror="alert(1)](https://e.com/i.png)')
    expect(out).not.toContain('onerror="alert(1)"')
  })

  // ⚠️ Control. Without this the assertions above pass on any renderer that emits nothing at all,
  // and they would also pass if a well-meaning change started escaping `&` in hrefs twice.
  test("ordinary links and images still render, and a query string is not double-encoded", () => {
    const link = render("[ok](https://e.com/?a=1&b=2)")
    expect(link).toContain('class="external-link"')
    expect(link).toContain('target="_blank"')
    expect(link).toContain("ok")
    expect(link, "the href was escaped twice — `&amp;amp;` reaches the browser as a literal `&amp;`").not.toContain(
      "&amp;amp;",
    )

    const image = render('![alt](https://e.com/i.png "a title")')
    expect(image).toContain('class="agent-file-image"')
    expect(image).toContain('alt="alt"')
    expect(image).toContain('title="a title"')
  })

  test("a resolved host file becomes a download link whose PATH is escaped", () => {
    // 🔴 The anchor no longer carries an instance URL at all — a `download` href is fetched by the
    // browser, which sends no `Authorization`. What it carries is the model's own href, in a data
    // attribute the click handler reads back, and that value is untrusted input in an HTML string
    // exactly as the url was.
    const out = marked
      .use({
        renderer: fileRenderer({
          target: () => ({ name: "out.md", image: false }),
          inline: () => Promise.resolve({ ok: false, reason: "unreadable" as const }),
          download: () => {},
        }),
      })
      .parse('[report](<https://host/f?q="x>)', { async: false }) as string
    expect(out).toContain('data-agent-file="true"')
    expect(out).toContain('href="#"')
    expect(out, "the resolved path was interpolated raw").not.toContain('?q="x')
    expect(out).toContain("&quot;")
  })
})
