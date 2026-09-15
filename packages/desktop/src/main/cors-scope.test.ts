import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The desktop must not hand out a blanket `Access-Control-Allow-Origin`.
//
// WHY THIS IS A RATCHET AND NOT A COMMENT. The instance server implements a deliberate CORS policy:
// `packages/server/src/cors.ts` allowlists `nc://renderer` plus localhost and refuses everything
// else, `packages/novaclaw/test/server/httpapi-cors.test.ts` pins that `https://evil.example` is
// refused, and a `corsVaryFix` middleware exists purely to keep `Vary: Origin` honest for that
// per-origin echo. The desktop then overwrote the echo with `*` on every response, which nullified
// all of it INSIDE the app — the one place the allowlist is supposed to matter most, since that is
// where an `allow-scripts` sandboxed agent canvas (`Origin: null`) runs. Nothing failed when that
// was true, which is exactly the defect class ruling 1 exists for.
//
// It was then narrowed to ONE host (`novaclaw.app`, for the What's-new changelog feed). That feed
// and its broker are gone (owner, 2026-09-15 — the Settings → General Updates section was scrapped),
// so the last reason to write the header went with them. This ratchet now asserts the stronger
// statement: the header is written NOWHERE in this file.
//
// ⚠️ This is a SOURCE ratchet by necessity — the behaviour it guards lives in the Electron main
// process and can only be observed by running the packaged or dev app, which the gate cannot do.

const WINDOWS_TS = join(import.meta.dir, "windows.ts")
const source = readFileSync(WINDOWS_TS, "utf8")

/** Strip comments so prose about the retired wildcard cannot satisfy — or trip — the checks. */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1")

describe("the desktop does not blanket-allow cross-origin reads", () => {
  test("the instrument is real — windows.ts was read and comment-stripping left the code", () => {
    // A ratchet whose parser silently matches nothing passes forever.
    expect(source.length).toBeGreaterThan(1000)
    expect(code).toContain("addRendererHeaders")
    expect(code).toContain("upsertKeyValue")
  })

  test("no Access-Control-Allow-Origin is written at all", () => {
    // The changelog feed that was the only justification for writing it is gone; the instance
    // server's own CORS policy is the only thing allowed to answer cross-origin reads.
    expect(code).not.toMatch(/Access-Control-Allow-Origin/)
    expect(code).not.toContain("ACAO_INJECT_ORIGINS")
  })

  test("Access-Control-Allow-Headers is not wildcarded at all", () => {
    expect(code).not.toMatch(/Access-Control-Allow-Headers/)
  })

  test("the request-side ACAO hook stays deleted — it never did anything", () => {
    // ACAO is a response header; no step of the Fetch/CORS algorithm reads it on a request.
    // Measured: disabling this hook alone changed nothing in the running app.
    const before = code.indexOf("onBeforeSendHeaders")
    if (before !== -1) {
      const block = code.slice(before, before + 400)
      expect(block).not.toMatch(/Access-Control-Allow-Origin/)
    }
  })
})
