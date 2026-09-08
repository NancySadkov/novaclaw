import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { countSites, ledgerFaults, type LedgerEntry, scanLogSource, scanPackageSources } from "./lib/log-event-ledger"

/** `packages/core/test` -> app repository root. */
const ROOT = path.resolve(import.meta.dir, "..", "..", "..")
const SITES = scanPackageSources(ROOT)
const UNKEYED = countSites(SITES, "unkeyed")
const UNKEYED_SITES = SITES.filter((site) => site.kind === "unkeyed")
const KEYED = countSites(SITES, "keyed")

/**
 * 🔴 **The allowance is GONE — 1b finished on 2026-08-06 and this is 1c's SCAN half.**
 *
 * It used to be a shrink-only list of not-yet-migrated calls, seeded at 233 and worked down through
 * 145 → 34 → 25 → 22 → **0**. The item said: *when it reaches zero, the final SCAN half deletes the
 * allowance and makes every direct call a hard failure.* It reached zero, so the list is deleted and
 * the rule is now absolute — **no direct `Effect.log` call survives anywhere in the shipping
 * source, and a new one fails here.**
 *
 * ⚠️ **An empty allowance is not the same as no allowance, which is why the file is gone rather than
 * emptied.** An empty JSON array still reads as "add your entry here": the next author under time
 * pressure appends one line and the invariant is quietly back to being a suggestion. Deleting the
 * fixture means re-opening the door is a visible act with a commit message attached.
 *
 * The exemption that does NOT exist: `schema/log.ts` implements `Log.event` via `LOG_AT[level](…)`
 * and `log-events.ts` is the registry — neither calls `Effect.log*`, so neither needs carving out. An
 * earlier note here claimed they did; that came from a regex scanner counting a `cause` inside a doc
 * comment, and the AST never agreed.
 */
const NO_ALLOWANCE: readonly LedgerEntry[] = []

describe("the log-event migration ledger", () => {
  test("walks the real production source boundary", () => {
    expect(SITES.length).toBeGreaterThan(200)
    expect(KEYED.length).toBeGreaterThan(0)
    expect(SITES.length).toBe([...UNKEYED, ...KEYED].reduce((total, entry) => total + entry.count, 0))
  })

  test("🔴 there is no direct Effect.log* call in the shipping source, at all", () => {
    // The whole of logging 1b, as one assertion. A failure names the offending call; the fix is to
    // declare a key in `schema/log-events.ts` and emit it with `Log.event`, never to re-add a list.
    const faults = ledgerFaults(UNKEYED, NO_ALLOWANCE)
    expect(faults.unlisted).toEqual([])
    expect(faults.stale).toEqual([])
    expect(UNKEYED_SITES).toEqual([])
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
        // `{ count: 1 }` reuses no formatter-owned name, so this is unconverted rather than broken.
        reserved: false,
      },
      {
        kind: "keyed",
        name: 'packages/example/src/example.ts :: Log.event("example.worker.start")',
        reserved: false,
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
 * weigh the same in production. An unkeyed call that reuses a formatter-owned name — an attribute
 * called `cause`, or a second positional argument, which the formatter folds onto `message` — emits
 * one key **twice** on the logfmt line. That breaks exactly the naive `grep`/`cut` mining that
 * logging item 1 exists to deliver; `log-events.test.ts` reproduces both forms as negative controls.
 *
 * Tracking the subset separately is what let the 2026-08-06 passes be aimed. Measured through this
 * parser: the server pass took collisions **3 → 0** while the unkeyed total moved only **25 → 22**. A
 * single number would have reported that as ordinary progress; the defect count reached zero.
 *
 * ⚠️ **This reads the AST, and the first version of it did not.** A regex sibling shipped hours
 * earlier, scanning a four-line window for the word `cause`. It counted a `cause` mentioned in the
 * DOC COMMENT of `schema/log.ts` as a live defect, and — because it matched text rather than call
 * arguments — its totals are **not comparable** to the ones above; the figures it produced for the
 * core pass (13 → 4) are quietly a different measurement and must not be extended into this series.
 * The parser already knew the difference. **One scanner, or the two disagree and the wrong one is
 * believed.**
 */
describe("the reserved-name collisions inside the remaining calls", () => {
  const collisions = UNKEYED_SITES.filter((site) => site.reserved)

  test("the count may FALL but never rise", () => {
    // Pinned at the 2026-08-06 measurement. Lower it in the commit that converts the sites; raising
    // it means a new call site reintroduced a duplicate column and should be written as Log.event.
    expect(collisions.length).toBeLessThanOrEqual(0)
  })

  test("a doc comment mentioning `cause` is not a call site (negative control)", () => {
    // The exact false positive the regex version produced against `schema/log.ts`.
    expect(
      scanLogSource("packages/example/src/example.ts", '/** `Effect.logInfo("a", cause)` emits message TWICE. */'),
    ).toEqual([])
  })

  test("both collision shapes are detected, and a clean call is not (negative control)", () => {
    const shapes = scanLogSource(
      "packages/example/src/example.ts",
      [
        'Effect.logWarning("attribute named cause", { cause })',
        'Effect.logError("second positional part", cause)',
        'Effect.logInfo("clean", { count: 1, sessionID: id })',
      ].join("\n"),
    )
    expect(shapes.map((site) => site.reserved)).toEqual([true, true, false])
  })

  test("a keyed call with a subsystem-scoped cause is NOT a collision", () => {
    // The migration's whole output: `snapshot.cause` is its own column and cannot shadow `cause`.
    const keyed = scanLogSource(
      "packages/example/src/example.ts",
      'Log.event("snapshot.capture.failed", { "snapshot.cause": String(error) })',
    )
    expect(keyed.map((site) => site.reserved)).toEqual([false])
  })
})
