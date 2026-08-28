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
//     `'unsafe-inline'` silently kills the inlined theme-preload script, and dropping
//     `'wasm-unsafe-eval'` silently kills the terminal. Both look like hardening and neither
//     fails anything else. (Until NC-SEC-032 the canvases were the reason for the first one;
//     they are served with their own policy now and no longer depend on this file.)
// See the header comment in `csp.ts` for the measurements behind each grant.

const dir = import.meta.dir
const source = (name: string) => readFileSync(join(dir, name), "utf8")

/**
 * Source with comment-only lines dropped, for the ledger checks that grep it.
 *
 * ⚠️ LINE-BASED, and that is the whole design. The obvious version — strip `/*…*​/` with a regex,
 * then `//…` — is worse than the bug it fixes: this very file's neighbour contains
 * `` `nc://renderer/*.html` `` inside a LINE comment, whose `/*` opened a block that ran to the
 * next `*​/` twenty lines below and deleted real code from the guard's view. A guard that quietly
 * stops looking at a region is a worse failure than one that occasionally matches prose, because
 * nothing announces it.
 *
 * A line-based filter cannot do that: it carries no state across lines, so the worst it can do is
 * keep one line it should have dropped. Trailing comments after code are kept for the same reason —
 * dropping them needs exactly the string-versus-comment parsing this is avoiding.
 */
function withoutComments(code: string) {
  return code
    .split("\n")
    .filter((line) => {
      const trimmed = line.trimStart()
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*")
    })
    .join("\n")
}

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
    // ⚠️ The REASON for 'unsafe-inline' changed under this assertion, so the assertion says the new
    // one. It used to be the agent canvases: they were `srcdoc`, which inherits this policy.
    // NC-SEC-032 moved them to a served document with a policy of its own, so canvases no longer
    // depend on this at all. What still does is `index.html`'s inlined theme-preload script, which
    // the WEB surface already serves under a sha256 hash instead — see NC-SEC-033.
    expect(script, "dropping 'unsafe-inline' kills the inlined theme-preload script in index.html") //
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

  /**
   * 🔴 NC-SEC-031 — a canvas navigating ITSELF was the last egress channel. The srcdoc's own
   * `default-src 'none'` (NC-SEC-003) does not cover it: a frame's navigation is checked against
   * its PARENT's `frame-src`, which without this directive fell back to `default-src` and its
   * `http:`/`https:` sources.
   *
   * A/B: delete `frame-src` from the directives and this fails on the fallback.
   */
  test("🔴 frame-src exists and does NOT reach the web", () => {
    expect(parsed["frame-src"], "without this directive frame-src falls back to default-src").toBeDefined()
    for (const remote of ["http:", "https:", "*", "ws:", "wss:"]) {
      expect(parsed["frame-src"], `a canvas could exfiltrate via ${remote}`).not.toContain(remote)
    }
  })

  test("🔴 frame-src still admits everything a canvas legitimately is", () => {
    // The other direction, and the one that would ship silently broken: measured in Chrome 148,
    // `about:srcdoc` is not matched against this list, so the canvases load under it. `data:` and
    // `blob:` stay because a canvas may frame something it generated itself.
    for (const local of ["'self'", "nc:", "data:", "blob:"]) {
      expect(parsed["frame-src"], `${local} is what the canvases and the app actually frame`).toContain(local)
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
    // ⚠️ Comments stripped FIRST. This matched a backtick-quoted `default-src 'none'` inside a
    // comment explaining why the canvas host is exempt from the app policy — prose, not a second
    // policy. A source regex that counts comments reports the fault it was written to catch in a
    // file that does not have it, and the cost is that someone eventually deletes the guard.
    expect(withoutComments(windows), "a second, hand-written policy string would drift from the tested one") //
      .not.toMatch(/["'`]default-src /)
  })

  /**
   * 🔴 NC-SEC-032 — the canvas host is the ONE document that must not get the app policy.
   *
   * Its whole purpose is to carry a different one, so that a canvas can execute its inline script
   * (which the served web UI's policy forbids, which is why canvases were dead there) while having
   * no network at all. Handing it `RENDERER_CSP` would give a canvas the app's own reach.
   *
   * A/B: delete either `isHtmlEmbedDocument` branch and the matching assertion fails.
   */
  test("🔴 both header seams exempt the canvas host from the app policy", () => {
    for (const name of ["addHtmlDocumentHeaders", "addRendererHeaders"]) {
      const body = withoutComments(functionBody(windows, name))
      expect(body, `${name} must recognise the embed document`).toContain("isHtmlEmbedDocument")
      expect(body, `${name} must give it the embed policy`).toContain("HTML_EMBED_CSP")
    }
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
