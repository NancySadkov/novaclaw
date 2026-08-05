import { describe, expect, test } from "bun:test"
import {
  MAX_SHARDS,
  MIN_VIABLE_BYTES,
  peakFor,
  peakRegressed,
  planFor,
  requiredBytes,
  SLACK_BYTES,
  UNPROFILED_PEAK_MB,
  unitsThatFit,
  WHOLE_HEADROOM_FACTOR,
} from "./memory-plan"

/**
 * The ladder that replaced a flat 6 GB free-RAM floor for tests.
 *
 * The floor's problem was not that it was cautious, it was that it was a CONSTANT: measured
 * 2026-08-05, `core` — the heaviest fast-tier unit — peaks at ~1.0 GB run whole, so the gate refused
 * on an ordinary desktop to protect against a job needing one gigabyte, and stayed refused for a
 * working day. Worse, the substitute for a refused gate (running the files in batches) was green
 * while the whole unit wedged: a refusal can HIDE a defect, not only prevent one.
 *
 * Every case below is written against a real measurement rather than a round number.
 */

const MB = 1024 ** 2
const GB = 1024 ** 3

/** What the sampler recorded on 2026-08-05. `core` is the unit the old floor was really about. */
const MEASURED = { core: 1007, schema: 300, "novaclaw:server": 900 }

describe("requiredBytes — a unit's own peak, not a constant", () => {
  test("scales with the measurement and adds fixed slack", () => {
    expect(requiredBytes(1007)).toBe(Math.round(1007 * MB * WHOLE_HEADROOM_FACTOR) + SLACK_BYTES)
  })

  test("core's real requirement is well under the 6 GB floor it used to face", () => {
    // The headline of the whole change, pinned so a future edit to the factors cannot quietly
    // re-create a floor nothing measured.
    expect(requiredBytes(MEASURED.core)).toBeLessThan(2 * GB)
  })
})

describe("planFor — the rungs", () => {
  test("plenty of headroom runs the unit WHOLE, which is the only canonical result", () => {
    expect(planFor(MEASURED.core, 8 * GB).mode).toBe("whole")
  })

  test("exactly the requirement still runs whole — the boundary is inclusive", () => {
    const required = requiredBytes(MEASURED.core)
    expect(planFor(MEASURED.core, required).mode).toBe("whole")
    expect(planFor(MEASURED.core, required - 1).mode).not.toBe("whole")
  })

  test("the condition that blocked a whole working day now runs core WHOLE", () => {
    // Free RAM sat at 1.7-3.7 GB on the owner's box all of 2026-08-05 and the flat 6 GB floor refused
    // every time. core's real requirement is ~1.8 GB, so at 2.0 GB it is not even a degraded run —
    // it is the canonical one. That gap between "refused" and "runs whole" IS the finding.
    expect(planFor(MEASURED.core, 2.0 * GB).mode).toBe("whole")
  })

  test("tighter than that it SHARDS instead of refusing", () => {
    const plan = planFor(MEASURED.core, 1.5 * GB)
    expect(plan.mode).toBe("sharded")
    if (plan.mode !== "sharded") throw new Error("unreachable")
    expect(plan.shards).toBeGreaterThanOrEqual(2)
    expect(plan.shards).toBeLessThanOrEqual(MAX_SHARDS)
  })

  test("below one shard's floor it REFUSES — squeezing has a bottom", () => {
    // Peak is nearly flat in file count (784 MB for 27 files, ~1 GB for 321), so there is no split
    // that fits a unit into 400 MB. Pretending otherwise would trade a clear refusal for a swap storm.
    expect(planFor(MEASURED.core, MIN_VIABLE_BYTES - 1).mode).toBe("refuse")
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

describe("peakFor — an unprofiled unit is assumed expensive", () => {
  test("uses the measurement when there is one", () => {
    expect(peakFor(MEASURED, "core")).toBe(1007)
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
    const fits = unitsThatFit(MEASURED, ["core", "schema", "novaclaw:server"], 1.2 * GB)
    expect(fits).toEqual(["schema"])
  })

  test("returns nothing when nothing fits, rather than a misleading suggestion", () => {
    expect(unitsThatFit(MEASURED, ["core", "schema"], 100 * MB)).toEqual([])
  })
})

describe("peakRegressed — reported, and deliberately hard to trip", () => {
  test("ordinary run-to-run variance is not a regression", () => {
    // This suite swings 24 % on a byte-identical tree; a threshold tighter than that reports noise,
    // and a report nobody believes is worse than no report.
    expect(peakRegressed(1007, 1250)).toBe(false)
  })

  test("a genuine jump is", () => {
    expect(peakRegressed(1007, 2200)).toBe(true)
  })
})
