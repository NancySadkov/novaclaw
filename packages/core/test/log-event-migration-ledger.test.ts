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

/**
 * 🔴 **Which of the remaining calls are DEFECTS, not merely unconverted.**
 *
 * The ledger above is a migration counter: every unkeyed call weighs the same in it. They do not
 * weigh the same in production. `RESERVED_ATTRIBUTES` names the columns the formatter already emits,
 * so an unkeyed call passing `cause` puts that name on the logfmt line **twice** — which breaks the
 * naive `grep`/`cut` mining that is the whole requirement of logging item 1, and which
 * `log-events.test.ts` reproduces as a negative control.
 *
 * Tracking the subset separately is what let the 2026-08-06 core pass be aimed: it converted nine
 * sites and took the live-defect count from **13 to 4** while the raw count moved only 36 → 27. A
 * single number would have reported that as ordinary progress.
 *
 * ⚠️ **The window must span the call, not its first line.** Measured the same day: a one-line check
 * finds 3 collisions where a four-line window finds 13, because the attribute object is almost always
 * wrapped by the formatter. A guard that undercounts a defect fourfold reports progress that has not
 * happened.
 */
describe("the reserved-name collisions inside the remaining calls", () => {
  const RAW_CALL = /Effect\.log(?:Debug|Info|Warning|Error|Trace)?\(/
  /** From `RESERVED_ATTRIBUTES` — the names the formatter owns. `cause` is the one that occurs. */
  const RESERVED = /\bcause\b/
  const WINDOW = 4

  const collisionsIn = (text: string): number => {
    const lines = text.split("\n")
    return lines.filter(
      (line, index) => RAW_CALL.test(line) && RESERVED.test(lines.slice(index, index + WINDOW).join("\n")),
    ).length
  }

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, out)
      else if (entry.name.endsWith(".ts") && !entry.name.includes(".test.")) out.push(full)
    }
    return out
  }

  const live = walk(path.join(ROOT, "packages"))
    .filter((file) => file.replace(/\\/g, "/").includes("/src/"))
    .reduce((total, file) => total + collisionsIn(fs.readFileSync(file, "utf8")), 0)

  test("the count may FALL but never rise", () => {
    // Pinned at the 2026-08-06 measurement. Lower it in the commit that converts the sites; raising
    // it means a new call site reintroduced a duplicate column and should be written as Log.event.
    expect(live).toBeLessThanOrEqual(4)
  })

  test("the whole-call window is the measurement, and a one-line check is not (negative control)", () => {
    const wrapped = ['Effect.logWarning("failed to materialize reference", {', "  name,", "  cause,", "})"].join("\n")
    expect(collisionsIn(wrapped)).toBe(1)
    // The same text seen one line at a time finds nothing — this is the undercount to avoid.
    expect(wrapped.split("\n").filter((line) => RAW_CALL.test(line) && RESERVED.test(line)).length).toBe(0)
  })

  test("a keyed call with a subsystem-scoped cause is NOT a collision", () => {
    // The migration's whole output: `snapshot.cause` is its own column and cannot shadow `cause`.
    expect(collisionsIn('Log.event("snapshot.capture.failed", { "snapshot.cause": String(error) })')).toBe(0)
  })
})
