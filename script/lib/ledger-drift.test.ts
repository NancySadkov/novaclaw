import { describe, expect, test } from "bun:test"
import { clean, compute } from "./ledger-drift"

/**
 * The regression these pin is the one that produced this module: a run matching its ledger, reported
 * as drift, with an empty body under the header. See `ledger-drift.ts` for the full account.
 */

const LEDGER = [
  "instance HttpApi > returns typed not found bodies for missing projects",
  "mcp HttpApi > serves status endpoint",
  "workspace HttpApi > proxies remote workspace requests selected from session ownership",
]

describe("expected-failure ledger drift", () => {
  test("🔴 a run in a DIFFERENT ORDER than the ledger is not drift", () => {
    // The actual 2026-08-06 defect. The ledger is stored alphabetically; a sharded run reports in
    // shard-interleaved order, which is never alphabetical for more than a handful of names.
    const shuffled = [LEDGER[2]!, LEDGER[0]!, LEDGER[1]!]
    expect(clean(compute(LEDGER, shuffled))).toBe(true)
  })

  test("a new failure is named", () => {
    const drift = compute(LEDGER, [...LEDGER, "event HttpApi > delivers instance events"])
    expect(drift.fresh).toEqual(["event HttpApi > delivers instance events"])
    expect(drift.fixed).toEqual([])
    expect(clean(drift)).toBe(false)
  })

  test("a fixed failure is named, so the ledger can only shrink deliberately", () => {
    const drift = compute(LEDGER, [LEDGER[1]!, LEDGER[0]!])
    expect(drift.fixed).toEqual([LEDGER[2]!])
    expect(drift.fresh).toEqual([])
    expect(clean(drift)).toBe(false)
  })

  test("both directions at once", () => {
    const drift = compute(LEDGER, [LEDGER[0]!, LEDGER[1]!, "a new one"])
    expect(drift.fresh).toEqual(["a new one"])
    expect(drift.fixed).toEqual([LEDGER[2]!])
  })

  test("a doubly-reported test is its own category, not a phantom mismatch", () => {
    // Collapsing to a Set would call this clean; the ORIGINAL comparison called it drift and then
    // printed nothing, because a length difference has no set-difference to show.
    const drift = compute(LEDGER, [...LEDGER, LEDGER[1]!])
    expect(drift.repeated).toEqual([LEDGER[1]!])
    expect(drift.fresh).toEqual([])
    expect(drift.fixed).toEqual([])
    expect(clean(drift)).toBe(false)
  })

  test("🔴 drift is NEVER reportable without something to report", () => {
    // The invariant the header depends on: `clean` is false only when a list below it is non-empty.
    // This is the property the replaced code violated, and it is the whole point of the module.
    const cases: ReadonlyArray<[string[], string[]]> = [
      [LEDGER, LEDGER],
      [LEDGER, []],
      [[], LEDGER],
      [LEDGER, [...LEDGER].reverse()],
      [LEDGER, [...LEDGER, LEDGER[0]!]],
      [LEDGER, ["unrelated"]],
      [[], []],
    ]
    for (const [pinned, failing] of cases) {
      const drift = compute(pinned, failing)
      const total = drift.fresh.length + drift.fixed.length + drift.repeated.length
      expect(clean(drift)).toBe(total === 0)
    }
  })

  test("an empty ledger with an empty run is clean (a green unit is not drift)", () => {
    expect(clean(compute([], []))).toBe(true)
  })
})
