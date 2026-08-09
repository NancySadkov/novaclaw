import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  IMPLAUSIBLE_PEAK_MB,
  MAX_SHARDS,
  MIN_VIABLE_BYTES,
  peakFor,
  peakRegressed,
  planFor as planForDemand,
  requiredBytes,
  SLACK_BYTES,
  UNPROFILED_PEAK_MB,
  unitsThatFit,
  unrecordableUnits,
  WHOLE_HEADROOM_FACTOR,
} from "./memory-plan"

/**
 * The ladder that replaced a flat 6 GB free-RAM floor for tests.
 *
 * The floor's problem was not that it was cautious, it was that it was a CONSTANT: it refused on an
 * ordinary desktop whatever the unit cost. Worse, the substitute for a refused gate (running the
 * files in batches) was green while the whole unit wedged: a refusal can HIDE a defect, not only
 * prevent one.
 *
 * 🔴 **This file used to be written against `core: 1007`, described as "what the sampler recorded on
 * 2026-08-05". That number was wrong by ~17× and every case here inherited it** — including one
 * asserting core's requirement is "well under 2 GB", which read as a headline and was an artefact of
 * a discarded measurement. The fixture below is the 2026-08-07 attributed re-baseline; where a case
 * still needs the old figure it says so and uses it as history, never as a current fact.
 *
 * Every case below is written against a real measurement rather than a round number.
 */

const MB = 1024 ** 2
const GB = 1024 ** 3

/**
 * The 2026-08-07 attributed re-baseline (largest attributed reading per unit).
 *
 * `core` is the unit this whole ladder is really about, and its entry is its own process (~7 380 MB,
 * flat) plus the sixteen `bun` workers its flock suites spawn themselves.
 */
const MEASURED = { core: 17_958, schema: 1236, "novaclaw:server": 2237, ui: 425 }

/** The dead entry, kept by name so a case about the defect cannot be mistaken for a current figure. */
const DEAD_CORE_ENTRY = 1007

/** Commit headroom on the same box at the same moment: ~25.7 GB free of a ~46 GB limit. */
const LAPTOP_COMMIT_FREE_BYTES = 25.72 * GB

/** Single-wall shorthand for the generic rung tests; dual-wall behavior has its own cases below. */
const planFor = (peakMb: number, headroomBytes: number) =>
  planForDemand(
    { commitPeakMb: peakMb, residentPeakMb: peakMb },
    { commitBytes: headroomBytes, residentBytes: headroomBytes },
  )

describe("requiredBytes — a unit's own peak, not a constant", () => {
  test("scales with the measurement and adds fixed slack", () => {
    expect(requiredBytes(1007)).toBe(Math.round(1007 * MB * WHOLE_HEADROOM_FACTOR) + SLACK_BYTES)
  })

  test("a modest unit's requirement is well under the 6 GB floor it used to face", () => {
    // The headline of the original change, pinned so a future edit to the factors cannot quietly
    // re-create a floor nothing measured. ⚠️ This case named `core` until 2026-08-07 and asserted
    // "< 2 GB" — true only of the discarded 1 007 MB reading. It is `novaclaw:server` now: a unit
    // whose ATTRIBUTED peak is real and still nowhere near the flat floor.
    expect(requiredBytes(MEASURED["novaclaw:server"])).toBeLessThan(4 * GB)
    expect(requiredBytes(MEASURED["novaclaw:server"])).toBeLessThan(6 * GB)
  })
})

describe("planFor — the rungs", () => {
  test("plenty of headroom runs the unit WHOLE, which is the only canonical result", () => {
    expect(planFor(MEASURED["novaclaw:server"], 8 * GB).mode).toBe("whole")
  })

  test("exactly the requirement still runs whole — the boundary is inclusive", () => {
    const required = requiredBytes(MEASURED["novaclaw:server"])
    expect(planFor(MEASURED["novaclaw:server"], required).mode).toBe("whole")
    expect(planFor(MEASURED["novaclaw:server"], required - 1).mode).not.toBe("whole")
  })

  test("the condition that blocked a whole working day still runs a modest unit WHOLE", () => {
    // Free RAM sat at 1.7-3.7 GB on the owner's box all of 2026-08-05 and the flat 6 GB floor refused
    // every time. `ui` needs ~1.0 GB, so at 2.0 GB it is not even a degraded run — it is the
    // canonical one. That gap between "refused" and "runs whole" IS the finding.
    expect(planFor(MEASURED.ui, 2.0 * GB).mode).toBe("whole")
  })

  test("tighter than that it SHARDS instead of refusing", () => {
    const plan = planFor(MEASURED["novaclaw:server"], 1.5 * GB)
    expect(plan.mode).toBe("sharded")
    if (plan.mode !== "sharded") throw new Error("unreachable")
    expect(plan.shards).toBeGreaterThanOrEqual(2)
    expect(plan.shards).toBeLessThanOrEqual(MAX_SHARDS)
  })

  test("below one shard's floor it REFUSES — squeezing has a bottom", () => {
    // The smallest attributed whole-unit peaks are `script` 270 MB and `ui` 415 MB, i.e. a bun
    // process with a module graph and an Effect runtime. There is no split that fits a unit into
    // 400 MB. Pretending otherwise would trade a clear refusal for a swap storm.
    //
    // ⚠️ The absolute figure is the load-bearing half. Asserting only against `MIN_VIABLE_BYTES - 1`
    // is self-referential — it passes for ANY floor, including zero, which a mutation demonstrated.
    expect(planFor(MEASURED["novaclaw:server"], 400 * MB).mode).toBe("refuse")
    expect(planFor(MEASURED["novaclaw:server"], MIN_VIABLE_BYTES - 1).mode).toBe("refuse")
  })

  test("shard count is capped — past the cap, process startup is the cost", () => {
    // A unit no plausible measurement would produce, so the cap is what answers rather than the
    // arithmetic. Without it a 20 GB "peak" would ask for dozens of processes and spend the whole
    // budget on bun startup.
    const plan = planFor(20_000, MIN_VIABLE_BYTES)
    if (plan.mode !== "sharded") throw new Error(`expected sharded, got ${plan.mode}`)
    expect(plan.shards).toBe(MAX_SHARDS)
  })

  test("an unmeasurable host runs whole rather than inventing a number", () => {
    // Fail-open here is deliberate and narrow: `test.ts` refuses outright when the host cannot be
    // measured. This arm exists so a non-Windows platform without a probe is not permanently sharded.
    expect(planFor(MEASURED.core, Number.NaN).mode).toBe("whole")
  })
})

/**
 * ─── what the 2026-08-07 re-baseline actually CHANGED, pinned so it cannot be quietly undone ──────
 *
 * These cases exist because the numbers alone do not carry the finding. `core`'s entry moving
 * 1 007 → 17 958 is not a bigger number, it is a unit that has left the reachable part of the ladder
 * on the machine we develop on, and a reader who does not know that will read a permanent `sharded`
 * as a transient low-memory condition.
 */
describe("core after the resident measurement — each demand meets its own wall", () => {
  const CORE_RESIDENT_MB = 4616

  test("core can plan whole when both independent walls clear their matching measurement", () => {
    const plan = planForDemand(
      { commitPeakMb: MEASURED.core, residentPeakMb: CORE_RESIDENT_MB },
      { commitBytes: LAPTOP_COMMIT_FREE_BYTES, residentBytes: 8 * GB },
    )
    expect(plan.mode).toBe("whole")
  })

  test("NEGATIVE CONTROL — swapping the walls recreates the permanent false sharding", () => {
    const correct = planForDemand(
      { commitPeakMb: MEASURED.core, residentPeakMb: CORE_RESIDENT_MB },
      { commitBytes: LAPTOP_COMMIT_FREE_BYTES, residentBytes: 8 * GB },
    )
    const crossed = planForDemand(
      { commitPeakMb: MEASURED.core, residentPeakMb: CORE_RESIDENT_MB },
      { commitBytes: 8 * GB, residentBytes: LAPTOP_COMMIT_FREE_BYTES },
    )
    expect(correct.mode).toBe("whole")
    expect(crossed.mode).toBe("sharded")
  })

  test("either real wall can independently force degradation", () => {
    const demand = { commitPeakMb: MEASURED.core, residentPeakMb: CORE_RESIDENT_MB }
    expect(planForDemand(demand, { commitBytes: 25 * GB, residentBytes: 4 * GB }).mode).toBe("sharded")
    expect(planForDemand(demand, { commitBytes: 25 * GB, residentBytes: 8 * GB }).mode).toBe("whole")
    expect(planForDemand(demand, { commitBytes: 15 * GB, residentBytes: 8 * GB }).mode).toBe("sharded")
  })

  test("the dead entry would have run core whole on a nearly empty box — the hazard, kept as a case", () => {
    // The guard exists to prevent the 2026-07-20 hard crash. At 1 007 MB it required ~1.8 GB against
    // a unit that really commits ~17 GB, so it would have started core WHOLE with 2 GB free.
    expect(planFor(DEAD_CORE_ENTRY, 2 * GB).mode).toBe("whole")
    expect(planFor(MEASURED.core, 2 * GB).mode).not.toBe("whole")
  })

  test("core's entry is BELOW the discard ceiling — the instrument can record it again", () => {
    // Both knobs had to move together or the entry could never be learned: at the old 8 192 MB
    // ceiling every reading of core was thrown away while the profile kept 1 007.
    expect(MEASURED.core).toBeLessThan(IMPLAUSIBLE_PEAK_MB)
    expect(MEASURED.core).toBeGreaterThan(8192)
  })
})

describe("unrecordableUnits — a profile entry the measurement can never update", () => {
  test("the shipped profile is fully recordable", () => {
    const parsed = JSON.parse(readFileSync(join(import.meta.dir, "..", "test-baseline.json"), "utf8")) as {
      peaks: Record<string, number>
    }
    expect(unrecordableUnits(parsed.peaks)).toEqual([])
    // The check must be reading a real profile, not an empty object — otherwise it passes vacuously.
    expect(Object.keys(parsed.peaks).length).toBeGreaterThan(10)
    expect(parsed.peaks.core).toBeGreaterThan(8192)
  })

  test("an entry at or above the ceiling is NAMED, not merely counted", () => {
    expect(unrecordableUnits({ core: IMPLAUSIBLE_PEAK_MB, ui: 425 })).toEqual(["core"])
    // Declared schema-first on purpose: the result is sorted, so a reader diffing two runs sees the
    // same order whatever order the profile happens to be written in.
    expect(unrecordableUnits({ schema: IMPLAUSIBLE_PEAK_MB, core: IMPLAUSIBLE_PEAK_MB + 1 })).toEqual([
      "core",
      "schema",
    ])
  })

  test("the historical pairing is what it catches: 1007 was fine, 17958 under 8192 was not", () => {
    // The defect reproduced against the old ceiling — core's true cost was unrecordable, and that is
    // why the entry stayed at a figure seventeen times too small for four consecutive gates.
    expect(unrecordableUnits({ core: DEAD_CORE_ENTRY }, 8192)).toEqual([])
    expect(unrecordableUnits({ core: MEASURED.core }, 8192)).toEqual(["core"])
  })
})

describe("peakFor — an unprofiled unit is assumed expensive", () => {
  test("uses the measurement when there is one", () => {
    expect(peakFor(MEASURED, "core")).toBe(17_958)
  })

  test("falls back to the generous default, never to zero", () => {
    // Zero would make an unknown unit look free and let it run on a box that cannot hold it — the
    // failure mode is a false wall-clock kill, which is what this whole file exists to prevent.
    expect(peakFor(MEASURED, "brand-new-unit")).toBe(UNPROFILED_PEAK_MB)
    expect(peakFor({}, "anything")).toBeGreaterThan(0)
  })
})

describe("unitsThatFit — the actionable half of a refusal", () => {
  test("names the units that would still run right now", () => {
    // A refusal that only says what is missing gives the reader nothing to do. This is the sentence
    // that turns it into a command they can run.
    const headroom = { commitBytes: 2.2 * GB, residentBytes: 2.2 * GB }
    const fits = unitsThatFit(MEASURED, {}, ["core", "ui", "novaclaw:server"], headroom)
    expect(fits).toEqual(["ui"])
  })

  test("returns nothing when nothing fits, rather than a misleading suggestion", () => {
    const headroom = { commitBytes: 100 * MB, residentBytes: 100 * MB }
    expect(unitsThatFit(MEASURED, {}, ["core", "ui"], headroom)).toEqual([])
  })
})

describe("peakRegressed — reported, and deliberately hard to trip", () => {
  test("ordinary run-to-run variance is not a regression", () => {
    // Real spread, not a round number: nine attributed `novaclaw:server` runs span 1 353-2 237 MB,
    // the widest of the twenty units. A threshold that fires on that reports noise, and a report
    // nobody believes is worse than no report.
    expect(peakRegressed(2237, 1353)).toBe(false)
    expect(peakRegressed(1353, 2237)).toBe(false)
  })

  test("a genuine jump is — and the one it missed for four gates is the case", () => {
    // 🔴 `core` sat at a 1 007 MB baseline while costing 17 958. This predicate would have shouted;
    // it never ran, because the reading was discarded before it got here. The detector was fine and
    // the ceiling above it was not — which is why `unrecordableUnits` exists.
    expect(peakRegressed(DEAD_CORE_ENTRY, MEASURED.core)).toBe(true)
  })
})
