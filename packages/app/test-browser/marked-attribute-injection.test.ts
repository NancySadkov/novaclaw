import { afterEach, describe, expect, test } from "bun:test"
import { parseWithFileRenderer } from "@novaclaw/ui/context/marked"

/**
 * 🔴 **THE PAYLOAD, PARSED — not the string, and not a shape.**
 *
 * `packages/ui` has no DOM, so its own `marked-attributes.test.ts` can only assert on the HTML text
 * the renderers produce. That is enough to catch a missing escape and not enough to prove the
 * consequence, because a string assertion is really an assertion about the author's regex. Here the
 * output is handed to a real parser and the questions are asked of the resulting NODES: how many
 * attributes does the anchor have, what are they called, and did an element appear that the markdown
 * did not contain.
 *
 * ⚠️ **These payloads are not hypothetical.** Measured against `marked@17.0.1`, which hands `href`,
 * `title` and `text` to a renderer completely raw — no entity escaping of any kind. Before the fix,
 * `[x](<https://e.com/" onmouseover="alert(1)>)` produced an anchor carrying a live `onmouseover`,
 * and the angle-bracket form could close the tag and open a second element inside it. The file's own
 * comment asserted the opposite ("marked already closes the quote vector there"), which is why this
 * test drives the real parser rather than trusting a reading of it.
 *
 * ⚠️ **The controls are as load-bearing as the payloads.** An ordinary link must still arrive with
 * its real `href` and `title`, and a query string must not come back double-encoded — both of those
 * pass in the unfixed tree, which is what makes the payload assertions discriminating.
 */

const render = (source: string): Promise<string> => parseWithFileRenderer(source)

/** Parse the renderer's output the way the product does: as HTML, into real nodes. */
async function parse(source: string): Promise<HTMLElement> {
  const host = document.createElement("div")
  host.innerHTML = await render(source)
  return host
}

const anchor = (host: HTMLElement) => {
  const element = host.querySelector("a")
  if (!element) throw new Error(`no anchor was rendered from: ${host.innerHTML}`)
  return element
}

const attributeNames = (element: Element) => [...element.attributes].map((item) => item.name).sort()

afterEach(() => {
  document.body.innerHTML = ""
})

describe("a markdown link cannot add an attribute or an element the author never wrote", () => {
  test("🔴 an href cannot close its own attribute and start a handler", async () => {
    const host = await parse('[x](<https://e.com/" onmouseover="alert(1)>)')
    const link = anchor(host)

    expect(link.getAttribute("onmouseover"), "the href broke out and became a live event handler").toBeNull()
    expect(attributeNames(link)).toEqual(["class", "href", "rel", "target"])
    // Positive half: the payload is still THERE, inside the href, or this test proves only that the
    // renderer emitted nothing.
    expect(link.getAttribute("href")).toBe('https://e.com/" onmouseover="alert(1)')
    expect(host.textContent?.trim()).toBe("x")
  })

  test("🔴 an href cannot close the tag and open an element inside it", async () => {
    // Not a hypothetical shape: `marked` tokenizes this as an ordinary inline link and hands the
    // renderer the whole `">` sequence, so the unescaped form ended the anchor's opening tag and
    // rendered the `<img>` as a sibling element the markdown never contained.
    const host = await parse('[x](https://e.com/"><img/src=x/onerror=alert(1)>)')

    expect(host.querySelector("img"), "an element the markdown never contained was rendered").toBeNull()
    expect(anchor(host).getAttribute("href")).toBe('https://e.com/"><img/src=x/onerror=alert(1)>')
    expect(host.textContent?.trim()).toBe("x")
  })

  test("🔴 a title cannot close its own attribute", async () => {
    const host = await parse('[x](https://e.com "a\\" onmouseover=\\"alert(1)")')
    const link = anchor(host)

    expect(link.getAttribute("onmouseover")).toBeNull()
    expect(link.getAttribute("title")).toBe('a" onmouseover="alert(1)')
  })

  test("🔴 a reference definition is the same door, and it is a separate code path in marked", async () => {
    const host = await parse('[x][r]\n\n[r]: <https://e.com/" onmouseover="alert(1)>')
    const link = anchor(host)

    expect(link.getAttribute("onmouseover")).toBeNull()
    expect(attributeNames(link)).toEqual(["class", "href", "rel", "target"])
  })

  test("🔴 an image src and title cannot either", async () => {
    const host = await parse('![alt](<https://e.com/i.png" onerror="alert(1)> "t\\" onload=\\"alert(2)")')
    const image = host.querySelector("img")
    if (!image) throw new Error(`no image was rendered from: ${host.innerHTML}`)

    expect(image.getAttribute("onerror")).toBeNull()
    expect(image.getAttribute("onload")).toBeNull()
    expect(attributeNames(image)).toEqual(["alt", "class", "src", "title"])
  })

  test("🔴 a resolved host file is escaped too — the path it carries is still a value in a string", async () => {
    // 🔴 The anchor carries no instance URL any more (a `download` href is fetched by the browser,
    // which sends no `Authorization`); it carries the MODEL'S OWN href in a data attribute, for the
    // click handler to mint a ticket against. That is untrusted input in an HTML string exactly as
    // the url was, and the same escaper has to close the slot.
    const html = await parseWithFileRenderer('[report](<https://host/f?q=" onmouseover="alert(1)>)', {
      target: () => ({ name: "out.md", image: false }),
      inline: () => Promise.resolve({ ok: false, reason: "unreadable" as const }),
      download: () => {},
    })
    const host = document.createElement("div")
    host.innerHTML = html
    const link = anchor(host)

    expect(link.getAttribute("onmouseover")).toBeNull()
    expect(attributeNames(link)).toEqual(["class", "data-agent-file", "data-agent-file-path", "download", "href"])
    // The path survives INTACT as a value — escaping that mangled it would break the download.
    expect(link.getAttribute("data-agent-file-path")).toBe('https://host/f?q=" onmouseover="alert(1)')
    // 🔴 And nothing fetchable is left on the element before a click.
    expect(link.getAttribute("href")).toBe("#")
  })

  // ⚠️ CONTROLS. Both pass in the unfixed tree; without them every assertion above is satisfied by a
  // renderer that emits nothing at all, or by one that escapes so eagerly that real links break.
  test("an ordinary link keeps its real href, title and text", async () => {
    const link = anchor(await parse('[ok](https://e.com/a/b?x=1&y=2 "a title")'))

    expect(link.getAttribute("href")).toBe("https://e.com/a/b?x=1&y=2")
    expect(link.getAttribute("title")).toBe("a title")
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toBe("noopener noreferrer")
    expect(link.textContent).toBe("ok")
  })

  test("a query string is not double-encoded on the way through", async () => {
    // `&amp;amp;` reaches the browser as a literal `&amp;` and the link stops working.
    expect(await render("[ok](https://e.com/?a=1&b=2)")).not.toContain("&amp;amp;")
    expect(anchor(await parse("[ok](https://e.com/?a=1&b=2)")).getAttribute("href")).toBe("https://e.com/?a=1&b=2")
  })

  test("an image with no title renders no title attribute at all", async () => {
    const image = (await parse("![alt](https://e.com/i.png)")).querySelector("img")
    expect(image?.hasAttribute("title")).toBe(false)
    expect(image?.getAttribute("alt")).toBe("alt")
  })
})
