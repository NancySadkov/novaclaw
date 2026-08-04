import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { RENDERER_CSP, RENDERER_CSP_DIRECTIVES, parseCsp } from "./csp"

// Ruling 1: an invariant whose violation compiles green ships with a mechanical check. Every
// failure this file guards for is invisible to `tsgo` AND to a running app on a dev box — the
// packaged renderer cannot be exercised from here, so "the window still opened" proves nothing
// about whether it opened with a policy.
//
// Two failure directions, both real:
//   • the policy DISAPPEARS or ROTS OPEN — a seam stops setting the header, a directive is
//     widened to `*`, or `'unsafe-eval'`/a remote script origin is added to script-src.
//   • the policy is TIGHTENED past what the product measurably needs — dropping
//     `'unsafe-inline'` silently kills every agent-drawn HTML canvas (an `about:srcdoc`
//     document inherits this policy), and dropping `'wasm-unsafe-eval'` silently kills the
//     terminal. Both look like hardening and neither fails anything else.
// See the header comment in `csp.ts` for the measurements behind each grant.

const dir = import.meta.dir
const source = (name: string) => readFileSync(join(dir, name), "utf8")

/** The body of a top-level `function name(...)` declaration, up to the next top-level one. */
function functionBody(code: string, name: string): string {
  const start = code.indexOf(`function ${name}(`)
  expect(start, `windows.ts must still declare ${name}()`).toBeGreaterThanOrEqual(0)
  const rest = code.slice(start)
  const end = rest.indexOf("\nfunction ", 1)
  return end === -1 ? rest : rest.slice(0, end)
}

describe("renderer Content-Security-Policy", () => {
  const parsed = parseCsp(RENDERER_CSP)

  test("serializes every declared directive, and round-trips", () => {
    expect(Object.keys(parsed)).toEqual(Object.keys(RENDERER_CSP_DIRECTIVES))
    for (const [name, sources] of Object.entries(RENDERER_CSP_DIRECTIVES)) {
      expect(parsed[name]).toEqual([...sources])
    }
    expect(RENDERER_CSP).not.toContain(";;")
  })

  test("declares a default-src", () => {
    // Without it, every directive this policy does not name is UNRESTRICTED — a policy that
    // looks strict in review and enforces nothing on connect/img/font/media/frame.
    expect(parsed["default-src"], "an absent default-src leaves unnamed directives wide open").toBeDefined()
    expect(parsed["default-src"]!.length).toBeGreaterThan(0)
  })

  test("no directive is a bare wildcard, and none is empty", () => {
    for (const [name, sources] of Object.entries(parsed)) {
      expect(sources, `${name} must list sources; an empty directive is not 'none'`).not.toEqual([])
      expect(sources, `${name} regressed to a bare * wildcard`).not.toContain("*")
    }
  })

  test("script-src admits no remote origin and no eval", () => {
    const script = parsed["script-src"]!
    // The point of this policy: an injected <script src="https://…"> cannot load, so an XSS
    // that beats the markdown sanitizer cannot pull a second stage down to a renderer holding
    // the `window.api` IPC bridge.
    for (const forbidden of ["'unsafe-eval'", "http:", "https:", "data:", "*"]) {
      expect(script, `script-src must not carry ${forbidden}`).not.toContain(forbidden)
    }
    expect(
      script.some((s) => /^https?:\/\//.test(s)),
      "script-src must not name a remote host",
    ).toBe(false)
  })

  test("script-src keeps the two grants the product measurably needs", () => {
    const script = parsed["script-src"]!
    // Removing either is a silent product break — see csp.ts. If the srcdoc embed in
    // packages/session-ui ever moves to its own origin, THAT is what retires 'unsafe-inline'.
    expect(script, "dropping 'unsafe-inline' kills every agent-drawn HTML canvas (srcdoc inherits this policy)") //
      .toContain("'unsafe-inline'")
    expect(script, "dropping 'wasm-unsafe-eval' kills the wasm terminal and the shiki worker") //
      .toContain("'wasm-unsafe-eval'")
  })

  test("style-src keeps 'unsafe-inline'", () => {
    // index.html's style= attribute on <html>, the injected <style id="oc-theme-preload">, and
    // Solid's element style writes. None of the three can carry a nonce.
    expect(parsed["style-src"]).toContain("'unsafe-inline'")
  })

  test("the execution and navigation directives are exactly 'none'", () => {
    for (const name of ["object-src", "base-uri", "form-action", "frame-ancestors"]) {
      expect(parsed[name], `${name} must stay 'none'`).toEqual(["'none'"])
    }
  })

  test("the custom renderer scheme is admitted alongside 'self'", () => {
    // The packaged window is `nc://renderer/index.html`; if `'self'` did not match a custom
    // standard scheme the whole renderer would fail to load, and that is not observable here.
    for (const name of ["default-src", "script-src", "style-src", "worker-src"]) {
      expect(parsed[name], `${name} must admit the nc: renderer scheme`).toContain("nc:")
    }
  })
})

describe("the policy is actually applied to the renderer document", () => {
  const windows = source("windows.ts")

  test("windows.ts takes the policy from csp.ts rather than restating it", () => {
    expect(windows).toContain('from "./csp"')
    expect(windows, "a second, hand-written policy string would drift from the tested one") //
      .not.toMatch(/["'`]default-src /)
  })

  test("the nc:// protocol seam sets it on renderer HTML", () => {
    const body = functionBody(windows, "addHtmlDocumentHeaders")
    expect(body).toContain("CSP_HEADER")
    expect(body).toContain("RENDERER_CSP")
  })

  test("the webRequest seam sets it on renderer HTML", () => {
    const body = functionBody(windows, "addRendererHeaders")
    expect(body).toContain("CSP_HEADER")
    expect(body).toContain("RENDERER_CSP")
    // It must stay behind the renderer-document gate: stamping a CSP onto every response the
    // session receives would apply it to remote instances' documents too.
    expect(body).toContain("isRendererUrl")
  })
})

describe("index.html carries no competing policy", () => {
  test("no <meta http-equiv=Content-Security-Policy>", () => {
    // One source of truth. A meta tag cannot express frame-ancestors, applies only after the
    // parser reaches it, and a second policy is enforced as an INTERSECTION — so a forgotten
    // meta breaks the app in a way that looks like a header bug.
    const html = readFileSync(join(dir, "../renderer/index.html"), "utf8")
    expect(html.toLowerCase()).not.toContain("content-security-policy")
  })
})
