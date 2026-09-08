/**
 * Two things are pinned here, and they fail for different reasons:
 *
 *  1. **the scanner tells a second DECLARATION from a second OBJECT** — the distinction a regex over
 *     the source cannot make, and the reason this is a tokenizer;
 *  2. **no tracked JSON config in this repo declares a key twice** — the sweep, run on every gate.
 *
 * The second is the actual guard. The first is what stops it from being a green line that means
 * nothing: a scanner that reported zero on everything would pass the sweep forever, so every
 * positive below is paired with the near-miss that must NOT be reported.
 */
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "bun:test"

import { describeDuplicate, duplicateKeys } from "./json-config"

const ROOT = join(import.meta.dir, "..", "..")

describe("duplicateKeys", () => {
  it("🔴 finds the three-declarations-of-one-key shape, and names every line", () => {
    // The shape this repo actually carried: three siblings in one object, all silently collapsed to
    // the last. They happened to agree, which is why it was invisible rather than merely quiet.
    const text = ['{', '  "options": { "typeAware": true },', '  "rules": {},', '  "options": {},', '  "options": { "typeAware": true }', '}'].join("\n") // prettier-ignore
    const [found, ...rest] = duplicateKeys(text)
    expect(rest).toEqual([])
    expect(found?.key).toBe("options")
    expect(found?.lines).toEqual([2, 4, 5])
    expect(found?.path).toBe("$")
    expect(describeDuplicate("x.json", found!)).toContain("only line 5 survives")
  })

  it("🔴 NEGATIVE CONTROL — two objects in one array share every key and that is legal", () => {
    // The case that makes a regex useless here. If this reports anything, the sweep below would be
    // red on half the repo and would simply be deleted by whoever hit it first.
    expect(duplicateKeys('{ "rules": [ { "id": 1, "on": true }, { "id": 2, "on": false } ] }')).toEqual([])
  })

  it("🔴 NEGATIVE CONTROL — a key-shaped STRING VALUE is not a declaration", () => {
    expect(duplicateKeys('{ "a": "\\"a\\": 1", "b": "a: 2" }')).toEqual([])
  })

  it("🔴 NEGATIVE CONTROL — a key-shaped line inside a COMMENT is not a declaration", () => {
    const text = ['{', '  "a": 1,', '  // "a": 2,', '  /* "a": 3 */', '  "b": 4', '}'].join("\n") // prettier-ignore
    expect(duplicateKeys(text)).toEqual([])
  })

  it("distinguishes nesting levels — the same key one level down is a different key", () => {
    expect(duplicateKeys('{ "a": 1, "b": { "a": 2 } }')).toEqual([])
  })

  it("reports a nested collision with the path a reader can navigate to", () => {
    const found = duplicateKeys('{ "compilerOptions": { "strict": true, "strict": false } }')
    expect(found).toHaveLength(1)
    expect(found[0]?.key).toBe("strict")
    expect(found[0]?.path).toBe("$.compilerOptions")
  })

  it("reports a collision inside an array element, and says it is in one", () => {
    const found = duplicateKeys('{ "rules": [ { "id": 1, "id": 2 } ] }')
    expect(found).toHaveLength(1)
    expect(found[0]?.path).toBe("$.rules[]")
  })

  it("never throws on malformed or truncated input", () => {
    // A guard that failed on a file it could not parse would turn a syntax error anywhere in the
    // tree into a confusing failure HERE, which is a worse outcome than the one it prevents.
    for (const text of ["", "{", '{"a": ', "not json at all", '{"a":1,,}', '{"a": "unterminated'])
      expect(() => duplicateKeys(text)).not.toThrow()
  })
})

/**
 * The sweep. A duplicate key is a silent discard — the parser keeps the last occurrence and the
 * earlier ones read as live configuration forever — so nothing but a mechanical check can see it.
 */
describe("no tracked JSON config declares a key twice", () => {
  const tracked = () => {
    const proc = spawnSync("git", ["ls-files", "-z", "--", "*.json", "*.jsonc"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 30_000,
    })
    return (proc.stdout ?? "").split("\0").filter(Boolean)
  }

  it("sweeps every one of them", () => {
    const files = tracked()
    // ⚠️ An empty list is what a broken `git ls-files` looks like, and it would pass the assertion
    // below without reading a single file. Say the count out loud so the check cannot be vacuous.
    expect(files.length).toBeGreaterThan(50)
    const offenders: string[] = []
    for (const file of files) {
      let text: string
      try {
        text = readFileSync(join(ROOT, file), "utf8")
      } catch {
        continue
      }
      for (const duplicate of duplicateKeys(text)) offenders.push(describeDuplicate(file, duplicate))
    }
    expect(offenders).toEqual([])
  })
})
