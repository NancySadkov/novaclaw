import { describe, expect, test } from "bun:test"

import { reservedBytes, SLACK_BYTES } from "./memory-plan"
import {
  admits,
  concurrencyCap,
  DEFAULT_MAX_CONCURRENCY,
  observedCosts,
  orderByCost,
  poolBudget,
} from "./run-schedule"

const GB = 1024 ** 3
const reservation = (unit: string, peakMb: number, profiled = true) => ({
  unit,
  commitBytes: reservedBytes(peakMb),
  residentBytes: reservedBytes(peakMb),
  profiled,
})

describe("admission against a reserved budget", () => {
  test("🔴 an EMPTY pool always admits — fitting one unit is the planner's decision, not this one", () => {
    // `MemoryPlan.planFor` can shard, and can refuse with a message naming what still fits. If this
    // function ever answered "no" on an empty pool the gate would simply stop, with none of that.
    expect(admits({ commitBytes: 0, residentBytes: 0 }, [], reservation("core", 10_822), 4).admit).toBe(true)
  })

  test("a second unit fits only when the budget still covers BOTH reservations", () => {
    const budget = { commitBytes: 23 * GB, residentBytes: 23 * GB }
    const core = reservation("core", 10_822) // ~13.7 GB reserved
    const server = reservation("novaclaw:server", 3_828) // ~4.9 GB reserved
    expect(admits(budget, [core], server, 4).admit).toBe(true)
    // A third of the same size no longer fits: 13.7 + 4.9 + 4.9 > 23.
    const verdict = admits(budget, [core, server], reservation("novaclaw:config", 3_828), 4)
    expect(verdict.admit).toBe(false)
    // The refusal has to name WHO is holding it, or the reader learns only that something is full.
    expect(verdict.admit === false && verdict.reason).toContain("commit budget")
    expect(verdict.admit === false && verdict.reason).toContain("2 unit(s)")
  })

  test("🔴 the two walls are judged INDEPENDENTLY, never collapsed", () => {
    // A machine can have commit headroom and no free RAM. Collapsing them through min() compares at
    // least one demand against the wrong quantity — the category error `memory-plan.ts` was written
    // to end, restated here because a scheduler is the second place it can be made.
    const budget = { commitBytes: 40 * GB, residentBytes: 4 * GB }
    const verdict = admits(budget, [reservation("core", 2_000)], reservation("ui", 2_000), 4)
    expect(verdict.admit).toBe(false)
    expect(verdict.admit === false && verdict.reason).toContain("resident budget")
  })

  test("the cap binds even when memory does not", () => {
    const budget = { commitBytes: 900 * GB, residentBytes: 900 * GB }
    const inFlight = ["a", "b"].map((n) => reservation(n, 100))
    expect(admits(budget, inFlight, reservation("c", 100), 2).admit).toBe(false)
    expect(admits(budget, inFlight, reservation("c", 100), 3).admit).toBe(true)
  })
})

describe("the concurrency cap", () => {
  test("🔴 `NOVACLAW_TEST_CONCURRENCY=1` is the serial A/B arm and must be exactly serial", () => {
    expect(concurrencyCap(20, "1")).toBe(1)
  })

  test("an override above the default is honoured — the cap is conservative, not a ceiling", () => {
    expect(concurrencyCap(20, "8")).toBe(8)
  })

  test("nonsense and absence fall back to the measured default", () => {
    expect(concurrencyCap(20, undefined)).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(concurrencyCap(20, "")).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(concurrencyCap(20, "nope")).toBe(DEFAULT_MAX_CONCURRENCY)
    expect(concurrencyCap(20, "0")).toBe(DEFAULT_MAX_CONCURRENCY)
  })

  test("a small machine keeps cores for the runner, and never drops below 1", () => {
    expect(concurrencyCap(4, undefined)).toBe(2)
    expect(concurrencyCap(2, undefined)).toBe(1)
    expect(concurrencyCap(1, undefined)).toBe(1)
    expect(concurrencyCap(Number.NaN, undefined)).toBe(1)
  })
})

describe("observed costs from the peak series", () => {
  const row = (o: Record<string, unknown>) => JSON.stringify(o)

  test("the MEDIAN of a unit's healthy runs", () => {
    const series = [
      row({ unit: "core", kind: "test", ok: true, ms: 200_000 }),
      row({ unit: "core", kind: "test", ok: true, ms: 300_000 }),
      row({ unit: "core", kind: "test", ok: true, ms: 280_000 }),
    ].join("\n")
    expect(observedCosts(series).get("core")).toBe(280_000)
  })

  test("🔴 a wall-clock-killed run contributes its BACKSTOP, not its cost — so failures are excluded", () => {
    // core's backstop is 600 s. Two kills would drag its median toward ten minutes and pin it to the
    // front of the queue on the strength of the runs where it did not work.
    const series = [
      row({ unit: "core", kind: "test", ok: true, ms: 200_000 }),
      row({ unit: "core", kind: "test", ok: false, ms: 600_000 }),
      row({ unit: "core", kind: "test", ok: false, ms: 600_000 }),
    ].join("\n")
    expect(observedCosts(series).get("core")).toBe(200_000)
  })

  test("typecheck rows, malformed lines and blanks are skipped rather than thrown on", () => {
    const series = ["", "not json at all", row({ unit: "x", kind: "typecheck", ok: true, ms: 9 }), "  "].join("\n")
    expect(observedCosts(series).size).toBe(0)
    expect(observedCosts("").size).toBe(0)
  })
})

describe("longest-first ordering", () => {
  const units = [{ name: "schema" }, { name: "core" }, { name: "novaclaw:server" }, { name: "brand-new" }]
  const name = (u: { name: string }) => u.name

  test("the two long units lead, so the tail is not their whole length", () => {
    const costs = new Map([
      ["schema", 300],
      ["core", 277_000],
      ["novaclaw:server", 146_800],
    ])
    expect(orderByCost(units, name, costs).map(name)).toEqual(["core", "novaclaw:server", "schema", "brand-new"])
  })

  test("🔴 an unmeasured unit sorts LAST — a new unit is far more often small than another core", () => {
    const costs = new Map([["schema", 300]])
    expect(orderByCost(units, name, costs).map(name)).toEqual(["schema", "core", "novaclaw:server", "brand-new"])
  })

  test("stable on ties and on an empty history, so the same inputs give the same order", () => {
    expect(orderByCost(units, name, new Map()).map(name)).toEqual(units.map(name))
    const tied = new Map([
      ["schema", 5],
      ["core", 5],
      ["novaclaw:server", 5],
      ["brand-new", 5],
    ])
    expect(orderByCost(units, name, tied).map(name)).toEqual(units.map(name))
  })
})

/**
 * ─── the two arms that make the budget mean something ──────────────────────────────────────────
 *
 * Both were found by measuring what the pool would actually do on this box rather than by reading
 * the arithmetic, which is why they are pinned separately from the admission tests above.
 */
describe("an unprofiled unit runs SOLO", () => {
  test("🔴 a guessed demand is not a promise, so it may not be admitted beside anything", () => {
    // Measured 2026-09-02: every `novaclaw test/*` sub-unit is absent from `peaks` and several
    // really cost 3–9 GB. Three of them admitted at the 1200 MB guess promise 3.6 GB against ~20 GB.
    const budget = { commitBytes: 900 * GB, residentBytes: 900 * GB }
    const verdict = admits(budget, [reservation("core", 100)], reservation("novaclaw test/cli/", 1_200, false), 4)
    expect(verdict.admit).toBe(false)
    expect(verdict.admit === false && verdict.reason).toContain("no measured memory profile")
  })

  test("🔴 …and nothing may be admitted beside IT — the hazard is the pair, not the newcomer", () => {
    const budget = { commitBytes: 900 * GB, residentBytes: 900 * GB }
    const verdict = admits(budget, [reservation("novaclaw test/cli/", 1_200, false)], reservation("ui", 100), 4)
    expect(verdict.admit).toBe(false)
    expect(verdict.admit === false && verdict.reason).toContain("running alone")
  })

  test("an EMPTY pool still admits it — running solo is exactly what this rule asks for", () => {
    expect(admits({ commitBytes: 0, residentBytes: 0 }, [], reservation("x", 1_200, false), 4).admit).toBe(true)
  })
})

describe("the harness's slack is charged ONCE", () => {
  test("🔴 per-unit slack caps the pool at one on a loaded box, and it is not a real cost", () => {
    // `session-ui` peaks at 122 MB resident. With SLACK inside each reservation it would claim
    // 671 MB, of which 512 is a second copy of a runner process that does not exist.
    expect(reservedBytes(122)).toBeLessThan(SLACK_BYTES)
    const headroom = { commitBytes: 4 * GB, residentBytes: 4 * GB }
    const budget = poolBudget(headroom, SLACK_BYTES)
    expect(budget.residentBytes).toBe(4 * GB - SLACK_BYTES)
    // Six small units now fit where the slack-per-unit arithmetic allowed six times less.
    const six = Array.from({ length: 6 }, (_, i) => reservation(`u${i}`, 122))
    expect(admits(budget, six.slice(0, 5), six[5]!, 8).admit).toBe(true)
  })

  test("a budget can never go negative, however loaded the box", () => {
    const budget = poolBudget({ commitBytes: 10, residentBytes: 10 }, SLACK_BYTES)
    expect(budget.commitBytes).toBe(0)
    expect(budget.residentBytes).toBe(0)
  })
})
