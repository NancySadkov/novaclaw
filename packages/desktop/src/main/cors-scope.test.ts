import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// The desktop must not hand out a blanket `Access-Control-Allow-Origin: *`.
//
// WHY THIS IS A RATCHET AND NOT A COMMENT. The instance server implements a deliberate CORS policy:
// `packages/server/src/cors.ts` allowlists `nc://renderer` plus localhost and novaclaw.app and
// refuses everything else, `packages/novaclaw/test/server/httpapi-cors.test.ts` pins that
// `https://evil.example` is refused, and a `corsVaryFix` middleware exists purely to keep
// `Vary: Origin` honest for that per-origin echo. The desktop then overwrote the echo with `*` on
// every response, which nullified all of it INSIDE the app — the one place the allowlist is supposed
// to matter most, since that is where an `allow-scripts` sandboxed agent canvas (`Origin: null`)
// runs. Nothing failed when that was true, which is exactly the defect class ruling 1 exists for.
//
// The injection is NARROWED, not deleted, because one fetch measurably needs it: novaclaw.app sends
// no ACAO of its own, so the What's-new feed is unreadable without it. See `ACAO_INJECT_ORIGINS`.
//
// ⚠️ This is a SOURCE ratchet by necessity — the behaviour it guards lives in the Electron main
// process and can only be observed by running the packaged or dev app, which the gate cannot do. It
// was verified by hand in the dev app over CDP on 2026-07-30; this test keeps the shape from
// regressing between those manual checks.

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

  test("no unconditional wildcard Access-Control-Allow-Origin", () => {
    // The retired shape, in code rather than prose: the header name and a `*` on the same line.
    const offenders = code
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /Access-Control-Allow-Origin/.test(line) && /["'`]\*["'`]/.test(line))
      .filter(({ line }) => !/ACAO_INJECT_ORIGINS/.test(line))
    // One survivor is legitimate: the guarded injection inside the `ACAO_INJECT_ORIGINS` branch.
    // What must never come back is the header being written with no origin test at all — so this
    // asserts the write is reachable ONLY under that guard.
    expect(offenders.length).toBeLessThanOrEqual(1)
    if (offenders.length === 1) {
      const guarded = code.slice(0, code.indexOf(offenders[0]!.line))
      expect(guarded).toContain("ACAO_INJECT_ORIGINS.has(origin)")
    }
  })

  test("Access-Control-Allow-Headers is not wildcarded at all", () => {
    // Nothing needed it: the only cross-origin read is a plain GET with a safelisted `Accept`.
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

  test("the injection list is explicit, and every entry is an absolute https origin", () => {
    const match = source.match(/ACAO_INJECT_ORIGINS = new Set\(\[([^\]]*)\]\)/)
    expect(match).not.toBeNull()
    const origins = [...match![1]!.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!)
    expect(origins.length).toBeGreaterThan(0)
    for (const o of origins) {
      expect(o).toMatch(/^https:\/\//)
      // An origin is scheme+host+port and nothing else; a path here would never match `URL.origin`
      // and would silently disable the injection.
      expect(new URL(o).origin).toBe(o)
    }
  })
})
