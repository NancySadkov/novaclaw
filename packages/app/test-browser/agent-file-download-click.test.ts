import { afterEach, describe, expect, test } from "bun:test"
import { parseWithFileRenderer, type HostFileResolver } from "@novaclaw/ui/context/marked"
import { sanitizeMarkdown } from "@novaclaw/session-ui/markdown-cache"
import { handleAgentFileClick } from "@novaclaw/session-ui/markdown-agent-file"

/**
 * 🔴 **THE CLICK IS THE FEATURE, AND THIS IS WHERE THE THREE PACKAGES MEET.**
 *
 * The anchor is emitted in `packages/ui`, the handler lives in `packages/session-ui`, and the thing
 * that mints a credential and saves the file lives in `packages/app`. Each can be right and
 * unconnected — this subsystem has already shipped that once — and the failure is silent: the link
 * renders, it looks like a link, and clicking it does nothing.
 *
 * So nothing here is a fixture. The markup under test is what the REAL renderer produces, put
 * through the REAL sanitizer (the chat's markdown is sanitized before it is mounted, and an
 * attribute the sanitizer eats is an attribute the handler will never find), and clicked with a
 * real event.
 *
 * What is being closed: the anchor used to carry `<instance>/api/fs/read/<name>` in its `href`. A
 * `download` href is fetched by the BROWSER, which sends no `Authorization` header, so on any
 * instance with a server password the click saved the 401 body under the file's own name.
 */

const saved: string[] = []

const resolver: HostFileResolver = {
  target: (href) =>
    href.startsWith("/tmp/") ? { name: href.slice("/tmp/".length), image: href.endsWith(".png") } : undefined,
  inline: () => Promise.resolve({ ok: false, reason: "unreadable" as const }),
  download: (href) => {
    saved.push(href)
  },
}

const mount = async (markdown: string): Promise<HTMLElement> => {
  const host = document.createElement("div")
  host.innerHTML = sanitizeMarkdown(await parseWithFileRenderer(markdown, resolver))
  document.body.appendChild(host)
  return host
}

/** A real click, dispatched at a real element, delivered the way the component delivers it. */
const click = (element: Element, getResolver: () => HostFileResolver | undefined = () => resolver): MouseEvent => {
  const event = new MouseEvent("click", { bubbles: true, cancelable: true })
  let handled: boolean | undefined
  const listener = (raw: Event) => {
    handled = handleAgentFileClick(raw as MouseEvent, getResolver)
  }
  // The component attaches ONE delegated listener on the block root, never per-anchor.
  const root = element.closest("div") ?? element
  root.addEventListener("click", listener)
  element.dispatchEvent(event)
  root.removeEventListener("click", listener)
  expect(handled, "the delegated listener never ran").toBeDefined()
  return event
}

const anchor = (host: HTMLElement): HTMLAnchorElement => {
  const found = host.querySelector<HTMLAnchorElement>("a[data-agent-file]")
  if (!found) throw new Error(`no agent file link in: ${host.innerHTML}`)
  return found
}

afterEach(() => {
  saved.length = 0
  document.body.innerHTML = ""
})

describe("clicking a colleague's file link in the chat", () => {
  test("🔴 the anchor is not fetchable before the click, and the click reaches the host", async () => {
    const host = await mount("Here it is: [report](/tmp/report.pdf)")
    const link = anchor(host)

    // The pre-fix tree put the instance route here, and the browser fetched it with no credential.
    expect(link.getAttribute("href")).toBe("#")
    expect(link.getAttribute("data-agent-file-path")).toBe("/tmp/report.pdf")
    expect(link.getAttribute("download")).toBe("report")

    const event = click(link)

    expect(saved).toEqual(["/tmp/report.pdf"])
    // ⚠️ And the `#` must not navigate. Without this the fix trades a broken download for the chat
    // jumping to the top of the log, which is a worse thing to do to somebody mid-conversation.
    expect(event.defaultPrevented).toBe(true)
  })

  test("the handler is DELEGATED — a click on the link's own text reaches it", async () => {
    const host = await mount("[report](/tmp/report.pdf)")
    const inner = anchor(host).firstChild
    // marked renders the label as a text node; click its parent element, which is the case a real
    // user produces when the anchor wraps `<em>` or `<code>`.
    click(inner instanceof Element ? inner : anchor(host))

    expect(saved).toEqual(["/tmp/report.pdf"])
  })

  test("an image too large to inline degrades to the same click, not to a route", async () => {
    // The degraded-image anchor is a second emission site in the same renderer, and a fix applied
    // to one of two sites is this repo's most-repeated defect.
    const host = await mount("![chart](/tmp/huge.png)")
    const link = anchor(host)

    expect(link.getAttribute("href")).toBe("#")
    click(link)

    expect(saved).toEqual(["/tmp/huge.png"])
  })

  test("no resolver wired still swallows the click rather than scrolling the chat away", async () => {
    const host = await mount("[report](/tmp/report.pdf)")

    const event = click(anchor(host), () => undefined)

    expect(saved).toEqual([])
    expect(event.defaultPrevented).toBe(true)
  })

  /**
   * ⚠️ CONTROLS. Without them every assertion above is also satisfied by a handler that claims
   * EVERY click in the chat log — which would break each ordinary link a colleague writes and the
   * copy button beside every code block.
   */
  test("an ordinary link is left alone: not claimed, not prevented, nothing saved", async () => {
    const host = await mount("[docs](https://novaclaw.app)")
    const link = host.querySelector("a")!

    expect(link.getAttribute("href")).toBe("https://novaclaw.app")
    expect(link.hasAttribute("data-agent-file")).toBe(false)

    const event = click(link)

    expect(saved).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  test("a click on ordinary prose saves nothing and is not prevented", async () => {
    const host = await mount("just a sentence")

    const event = click(host.querySelector("p") ?? host)

    expect(saved).toEqual([])
    expect(event.defaultPrevented).toBe(false)
  })

  /**
   * 🔴 The sanitizer is part of the path, and it eats attributes it does not know.
   *
   * `data-agent-file-path` is the whole hook — if DOMPurify stripped it the anchor would render,
   * look right, and be inert. Asserted on the SANITIZED markup above; this pins the reason.
   */
  test("the hook survives the sanitizer", async () => {
    const host = await mount("[report](/tmp/report.pdf)")
    expect(anchor(host).hasAttribute("data-agent-file-path")).toBe(true)
  })
})
