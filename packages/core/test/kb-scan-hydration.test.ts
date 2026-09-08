import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The rule that makes memory readable: **a SCAN never carries the long string.**
//
// 🔴 Measured on the owner's instance 2026-08-21: a table scan returned an empty `text` for rows that
// a primary-key lookup returned in full — 40 of 40 blanked rows recovered by id, and a full scan found
// text on only 64 of 745. Every product read path scans, so the Memory app, the roster's per-agent
// cabinets and per-turn recall all showed blanks while the data sat there intact.
//
// ⚠️ This is a SOURCE ledger on purpose. The behaviour needs a store in the state the owner's is in —
// a from-scratch store does not reproduce it at 100 rows × 20 KB — so no test on a fresh store can
// fail when someone re-adds `m.text` to a scan. What CAN be checked mechanically is the rule itself:
// the read paths select ids and hydrate by key. A/B: put `m.text AS text` back into `list`'s
// selection query and this file goes red.

const ENGINE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "kb-graph", "wasm-engine.ts")
const source = readFileSync(ENGINE, "utf8")

/** The body of one method, from its signature to the next one at the same indent. */
const MEMBER = String.raw`\n  (?:private |protected |public )?(?:async )?`

const methodBody = (name: string): string => {
  // `private async _search(` and `list(` alike — the modifiers are not part of the question.
  const start = source.search(new RegExp(MEMBER + name + String.raw`\(`))
  expect(start, `${name} not found in wasm-engine.ts — this ledger is reading the wrong file`).toBeGreaterThan(-1)
  const rest = source.slice(start + 3)
  const end = rest.search(new RegExp(MEMBER + String.raw`[A-Za-z_]\w*\(`))
  return end === -1 ? rest : rest.slice(0, end)
}

/** Cypher projections that pull the long string out of a multi-row selection. */
const selectsText = (body: string): boolean => /RETURN[^`]*m\.text AS text/s.test(body)

describe("a scan selects ids; the bodies come back by primary key", () => {
  for (const name of ["list", "graph"]) {
    test(`${name}() does not project the long string from its scan`, () => {
      const body = methodBody(name)
      expect(selectsText(body), `${name}() projects m.text from a scan — that column comes back EMPTY`).toBe(false)
      expect(body, `${name}() must hydrate by key`).toContain("this.hydrate(")
    })
  }

  test("search() filters without the long string and hydrates the hits", () => {
    const body = methodBody("_search")
    expect(selectsText(body)).toBe(false)
    expect(body).toContain("this.hydrate(")
  })

  test("neighbors() traverses for ids and hydrates their text", () => {
    const body = methodBody("neighbors")
    expect(/RETURN[^`]*n\.text AS text/s.test(body)).toBe(false)
    expect(body).toContain("this.hydrate(")
  })

  test("hydrate itself matches on the PRIMARY KEY — the one read that comes back whole", () => {
    const body = methodBody("hydrate")
    expect(body).toContain("MATCH (m:Memory {id: $id})")
    // Per id, not `IN $ids`: the batched form HANGS on that store, pinning gigabytes before a kill.
    expect(body).not.toContain("IN $ids")
  })

  test("NEGATIVE CONTROL: the detector recognises the shape it is hunting", () => {
    // Without this, a renamed alias would make every assertion above vacuously true.
    expect(selectsText("RETURN m.id AS id, m.text AS text ORDER BY m.t_created DESC")).toBe(true)
    expect(selectsText("RETURN m.id AS id ORDER BY m.t_created DESC")).toBe(false)
  })
})
