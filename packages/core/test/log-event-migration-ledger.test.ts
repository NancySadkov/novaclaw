import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { countSites, ledgerFaults, type LedgerEntry, scanLogSource, scanPackageSources } from "./lib/log-event-ledger"

/** `packages/core/test` -> app repository root. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SITES = scanPackageSources(ROOT)
const UNKEYED = countSites(SITES, "unkeyed")
const KEYED = countSites(SITES, "keyed")

/**
 * The not-yet-migrated production calls at the instant logging 1c's LEDGER half shipped.
 *
 * This is deliberately a shrink-only allowance, not a target. A new `Effect.log*` call fails as
 * unlisted; converting a listed call to `Log.event` fails as stale until this list is shortened in
 * the same commit. When it reaches zero, logging 1c's final SCAN half deletes the allowance and
 * makes every direct call a hard failure.
 */
const UNKEYED_LEDGER = JSON.parse(
  fs.readFileSync(path.join(import.meta.dir, "fixtures", "unkeyed-log-sites.json"), "utf8"),
) as readonly LedgerEntry[]

describe("the log-event migration ledger", () => {
  test("walks the real production source boundary", () => {
    expect(SITES.length).toBeGreaterThan(200)
    expect(KEYED.length).toBeGreaterThan(0)
    expect(SITES.length).toBe([...UNKEYED, ...KEYED].reduce((total, entry) => total + entry.count, 0))
  })

  test("has no new bare calls and no stale allowances", () => {
    const names = UNKEYED_LEDGER.map((entry) => entry.name)
    expect(new Set(names).size).toBe(names.length)
    expect(UNKEYED_LEDGER.every((entry) => Number.isInteger(entry.count) && entry.count > 0)).toBe(true)

    const faults = ledgerFaults(UNKEYED, UNKEYED_LEDGER)
    expect(faults.unlisted).toEqual([])
    expect(faults.stale).toEqual([])
  })

  test("the parser sees multiline calls, ignores prose, and distinguishes keyed calls", () => {
    const synthetic = scanLogSource(
      "packages/example/src/example.ts",
      `
        // Effect.logError("comment only")
        Effect.logInfo(
          "wrapped message",
          { count: 1 },
        )
        Log.event("example.worker.start", { count: 1 })
      `,
    )
    expect(synthetic).toEqual([
      {
        kind: "unkeyed",
        name: 'packages/example/src/example.ts :: Effect.logInfo("wrapped message")',
      },
      {
        kind: "keyed",
        name: 'packages/example/src/example.ts :: Log.event("example.worker.start")',
      },
    ])
  })

  test("both directions bite (negative control)", () => {
    const allowed = [{ name: 'packages/example/src/example.ts :: Effect.logInfo("old")', count: 1 }]
    expect(ledgerFaults(allowed, allowed)).toEqual({ unlisted: [], stale: [] })

    expect(
      ledgerFaults(
        [...allowed, { name: 'packages/example/src/example.ts :: Effect.logWarning("new")', count: 1 }],
        allowed,
      ).unlisted,
    ).toEqual(['packages/example/src/example.ts :: Effect.logWarning("new") (+1 unledgered)'])

    expect(ledgerFaults([], allowed).stale).toEqual([
      'packages/example/src/example.ts :: Effect.logInfo("old") (-1; drop or decrement the ledger entry)',
    ])

    // Adding a duplicate of an already-ledgered call is still growth and cannot hide by name.
    expect(ledgerFaults([{ ...allowed[0]!, count: 2 }], allowed).unlisted).toEqual([
      'packages/example/src/example.ts :: Effect.logInfo("old") (+1 unledgered)',
    ])
  })
})
