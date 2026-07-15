import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// §0.7.2 — mechanical import-whitelist guard. Every engine source file under src/jh/ may import ONLY:
//   effect · ./… (jh-relative) · ../util/hash · node:… (process-runner/tools-basic/store only) ·
//   drizzle-orm/… (sql.ts only) · ../database/… (store.ts only).
// This keeps jh out of the LocationServiceMap and off the session/tool/config/v1/llm/schema trees, so
// Phases 1–13 cannot collide with F1 deletions. The guard scans the directory, so it grows as files
// appear — a new engine file with a stray import fails this test, not a downstream typecheck.

const DIR = import.meta.dir

const NODE_ALLOWED = new Set(["process-runner.ts", "tools-basic.ts", "store.ts"])

function violationFor(filename: string, spec: string): string | undefined {
  if (spec === "effect") return undefined
  if (spec.startsWith("./")) return undefined
  if (spec === "../util/hash") return undefined
  // improve18: the PURE affective homeostat (core root, zero dependencies) — Strict and the normal
  // drain loop must drive ONE engine, not two look-alikes. Whitelisted on the same grounds as
  // ../util/hash: a leaf module, no session/tool/config/v1/llm/schema reach (which is what §0.7.2
  // actually guards).
  if (spec === "../affective") return undefined
  if (spec.startsWith("node:")) {
    return NODE_ALLOWED.has(filename) ? undefined : `node: import "${spec}" not allowed in ${filename}`
  }
  if (spec.startsWith("drizzle-orm")) {
    // sql.ts declares the tables; store.ts (the DB seam) needs the query helpers (eq/asc).
    return filename === "sql.ts" || filename === "store.ts" ? undefined : `drizzle-orm import "${spec}" only allowed in sql.ts/store.ts (got ${filename})`
  }
  if (spec.startsWith("../database/")) {
    return filename === "store.ts" ? undefined : `../database import "${spec}" only allowed in store.ts (got ${filename})`
  }
  return `disallowed import "${spec}" in ${filename}`
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "") // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1") // line comments (but not the // in ://)
}

function specifiersOf(source: string): string[] {
  // Scan comment-stripped source; a real module specifier never contains whitespace, so anything with
  // a space (a stray `from "..."` in a string literal or comment fragment) is discarded as noise.
  const stripped = stripComments(source)
  const specs: string[] = []
  let m: RegExpExecArray | null
  const from = /\bfrom\s+["']([^"']+)["']/g
  while ((m = from.exec(stripped)) !== null) specs.push(m[1]!)
  const sideEffect = /(?:^|[\n;])\s*import\s+["']([^"']+)["']/g // `import "..."` side-effect form
  while ((m = sideEffect.exec(stripped)) !== null) specs.push(m[1]!)
  return specs.filter((s) => !/\s/.test(s))
}

const engineFiles = readdirSync(DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

describe("jh import whitelist", () => {
  test("at least the Phase-1 engine files are present", () => {
    expect(engineFiles).toContain("step.ts")
    expect(engineFiles).toContain("extract.ts")
  })

  for (const filename of engineFiles) {
    test(`${filename} imports only whitelisted specifiers`, () => {
      const source = readFileSync(join(DIR, filename), "utf8")
      const violations = specifiersOf(source)
        .map((spec) => violationFor(filename, spec))
        .filter((v): v is string => v !== undefined)
      expect(violations).toEqual([])
    })
  }
})
