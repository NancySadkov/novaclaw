import { describe, expect, test } from "bun:test"
import { classifyNavigation, createNavigationGuard, isRendererUrl, type RendererOrigin } from "./navigation"

const packaged: RendererOrigin = { devUrl: undefined }
const dev: RendererOrigin = { devUrl: "http://localhost:5173" }

describe("isRendererUrl", () => {
  test("trusts the packaged renderer scheme, and only on our host", () => {
    expect(isRendererUrl("nc://renderer/index.html", packaged)).toBe(true)
    expect(isRendererUrl("nc://renderer/settings", packaged)).toBe(true)
    // Same scheme, different host: the protocol handler already 404s this, and the trust
    // predicate has to agree with it.
    expect(isRendererUrl("nc://elsewhere/index.html", packaged)).toBe(false)
  })

  test("trusts the dev server by ORIGIN, not by prefix", () => {
    expect(isRendererUrl("http://localhost:5173/index.html", dev)).toBe(true)
    expect(isRendererUrl("http://localhost:5173/anything", dev)).toBe(true)
    // A prefix test would say yes to both of these.
    expect(isRendererUrl("http://localhost:51730/", dev)).toBe(false)
    expect(isRendererUrl("http://localhost:5173.evil.test/", dev)).toBe(false)
  })

  test("trusts no dev origin in a packaged build", () => {
    // The `resolveRendererDevUrl` half of the same rule: a packaged build gets `devUrl: undefined`
    // even when the environment carries one, so the origin is simply not in the set.
    expect(isRendererUrl("http://localhost:5173/index.html", packaged)).toBe(false)
  })

  test("the html flag narrows to documents, and only when asked", () => {
    expect(isRendererUrl("nc://renderer/api/thing", packaged, true)).toBe(false)
    expect(isRendererUrl("nc://renderer/api/thing", packaged, false)).toBe(true)
  })

  test("refuses garbage instead of throwing on it", () => {
    expect(isRendererUrl(undefined, packaged)).toBe(false)
    expect(isRendererUrl("", packaged)).toBe(false)
    expect(isRendererUrl("not a url", packaged)).toBe(false)
  })
})

describe("classifyNavigation", () => {
  test("allows the app's own renderer", () => {
    expect(classifyNavigation("nc://renderer/index.html", packaged)).toBe("allow")
    expect(classifyNavigation("http://localhost:5173/index.html", dev)).toBe("allow")
  })

  /**
   * 🔴 NC-SEC-002 — the preload belongs to the webContents, not to the document, so any page the
   * main frame reaches inherits `window.api` and with it the filesystem. No CSP directive covers
   * this (`navigate-to` was dropped and never shipped) and `setWindowOpenHandler` is a different
   * event, so top-frame navigation had no guard at all.
   *
   * A/B: return "allow" from the http/https arm and the two exfiltration cases below pass.
   */
  test("🔴 sends the whole web to the BROWSER, where there is no bridge", () => {
    expect(classifyNavigation("https://evil.test/steal", packaged)).toBe("external")
    expect(classifyNavigation("http://192.168.1.9/", packaged)).toBe("external")
    // An instance the user legitimately typed in under remote access is still not the renderer,
    // and must not become it. Remote instances are reached by FETCH, never by navigating to them.
    expect(classifyNavigation("https://novaclaw.app/", packaged)).toBe("external")
  })

  test("🔴 blocks every non-web scheme outright", () => {
    expect(classifyNavigation("file:///c:/Users/me/.ssh/id_ed25519", packaged)).toBe("block")
    expect(classifyNavigation("javascript:alert(1)", packaged)).toBe("block")
    expect(classifyNavigation("data:text/html,<script>1</script>", packaged)).toBe("block")
    expect(classifyNavigation("nc://elsewhere/index.html", packaged)).toBe("block")
    expect(classifyNavigation("about:blank", packaged)).toBe("block")
  })

  test("a string that is not a URL is blocked, never handed onward", () => {
    // The `external` arm calls `shell.openExternal`. That is the one branch with an effect outside
    // the app, so the input reaching it has to be a parsed web URL and nothing else.
    expect(classifyNavigation("not a url", packaged)).toBe("block")
    expect(classifyNavigation("", packaged)).toBe("block")
  })

  test("a dev build does not trust a DIFFERENT dev server", () => {
    // The control for the dev arm: `devUrl` is one origin, not "any localhost".
    expect(classifyNavigation("http://localhost:9999/index.html", dev)).toBe("external")
  })
})

describe("createNavigationGuard", () => {
  function harness(origin: RendererOrigin) {
    const opened: string[] = []
    const logged: string[] = []
    let prevented = 0
    const guard = createNavigationGuard({
      origin: () => origin,
      openExternal: (url) => opened.push(url),
      log: (message, url) => logged.push(`${message} ${url}`),
    })
    const go = (url: string) => guard({ preventDefault: () => prevented++ }, url)
    return { go, opened, logged, prevented: () => prevented }
  }

  test("lets the renderer navigate itself untouched", () => {
    const h = harness(packaged)
    h.go("nc://renderer/index.html")
    // Not merely "not opened externally" — nothing happened at all. A guard that prevented the
    // app's own navigation would be a white window.
    expect(h.prevented()).toBe(0)
    expect(h.opened).toEqual([])
    expect(h.logged).toEqual([])
  })

  test("🔴 refuses a remote navigation AND hands the URL to the browser", () => {
    const h = harness(packaged)
    h.go("https://evil.test/steal")
    // Both halves matter, and only together: preventing without opening loses the user's click,
    // opening without preventing leaves the bridge on a remote page.
    expect(h.prevented()).toBe(1)
    expect(h.opened).toEqual(["https://evil.test/steal"])
  })

  test("🔴 refuses a blocked scheme WITHOUT handing it to the shell", () => {
    const h = harness(packaged)
    h.go("file:///c:/Windows/System32/calc.exe")
    expect(h.prevented()).toBe(1)
    // The control for the test above: `external` is not "always open it". `shell.openExternal` on
    // a file: URL is a local-file launch, which is the bug this arm exists to not have.
    expect(h.opened).toEqual([])
  })

  test("logs both refusals, distinguishably", () => {
    const h = harness(packaged)
    h.go("https://evil.test/")
    h.go("file:///etc/passwd")
    expect(h.logged).toEqual([
      "refused main-frame navigation (external) https://evil.test/",
      "refused main-frame navigation (block) file:///etc/passwd",
    ])
  })

  test("re-reads the origin on every navigation", () => {
    // ⚠️ The guard is wired once, at window creation, and answers for the whole session. If it
    // captured the origin it would be a startup snapshot; this is the assertion that says so.
    let current: RendererOrigin = packaged
    const opened: string[] = []
    const guard = createNavigationGuard({
      origin: () => current,
      openExternal: (url) => opened.push(url),
      log: () => {},
    })
    guard({ preventDefault: () => {} }, "http://localhost:5173/index.html")
    expect(opened).toEqual(["http://localhost:5173/index.html"])
    current = dev
    guard({ preventDefault: () => {} }, "http://localhost:5173/index.html")
    expect(opened).toEqual(["http://localhost:5173/index.html"])
  })
})
