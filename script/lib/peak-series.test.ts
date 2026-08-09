import { describe, expect, test } from "bun:test"
import { buildRow, buildRows, classifyPeak, format, scopeLabel, seriesPath, type Observation } from "./peak-series"

/**
 * The row SHAPE is what these pin, not the filesystem. Every claim below is about a value a later
 * reader will do arithmetic on — and the whole point of the series is that somebody reads it weeks
 * from now, when the run that produced it is gone and only the row is left to be right.
 *
 * Two invariants earn their own tests because violating either compiles green (ruling 1):
 *   · a row is never comparable in one field and incomparable in another;
 *   · a scoped run is never indistinguishable from a full one.
 */

const PROFILE = { core: 1007, "novaclaw:server": 2133 }
const RUN = "2026-08-07T12:00:00.000Z"

const unit = (over: Partial<Observation> = {}): Observation => ({
  name: "core",
  kind: "test",
  ok: true,
  ms: 190_000,
  peakMb: 1200,
  ...over,
})

describe("peak series rows", () => {
  test("the delta is numeric in both forms, and both agree with the profile", () => {
    const row = buildRow(RUN, "default", unit({ peakMb: 1500, workingSetMb: 640 }), PROFILE)
    expect(row.profileMb).toBe(1007)
    expect(row.peakMb).toBe(1500)
    expect(row.deltaMb).toBe(493)
    expect(row.ratio).toBe(1.49)
    // The printed block's own threshold: 1500 is not > 1007 * 1.5 + 256 = 1766.5.
    expect(row.regressed).toBe(false)
    expect(row.workingSetMb).toBe(640)
  })

  test("🔴 the recorded verdict is the one the run PRINTED — the `core 7755` case", () => {
    // The observation that motivated this module. A series that disagreed with the line printed
    // beside it would be two answers to one question; `regressed` is imported from memory-plan
    // rather than re-derived here precisely so it cannot.
    const row = buildRow(RUN, "default", unit({ peakMb: 7755 }), PROFILE)
    expect(row.regressed).toBe(true)
    expect(row.deltaMb).toBe(6748)
    expect(row.ratio).toBe(7.701)
  })

  test("a unit absent from the profile carries a peak and NO derived fields", () => {
    const row = buildRow(RUN, "default", unit({ name: "novaclaw:fixture", peakMb: 874 }), PROFILE)
    expect(row.peakMb).toBe(874)
    expect(row.profileMb).toBeNull()
    expect(row.deltaMb).toBeNull()
    expect(row.ratio).toBeNull()
    expect(row.regressed).toBeNull()
  })

  test("an unmeasured peak is a row with nulls, not a missing row", () => {
    // test.ts discards an implausible sample outright (a stray bun once inflated core to 12 014 MB),
    // and a killed unit produces none. Dropping the row would make an unmeasurable unit look like a
    // healthy one; the null says which.
    const row = buildRow(RUN, "default", unit({ peakMb: undefined, ok: false }), PROFILE)
    expect(row.peakMb).toBeNull()
    expect(row.profileMb).toBe(1007)
    expect(row.deltaMb).toBeNull()
    expect(row.ok).toBe(false)
  })

  test("one or two owning ticks retain the sample but withhold the peak", () => {
    for (const ownTicks of [1, 2]) {
      const row = buildRow(
        RUN,
        "default",
        unit({ peakMb: 700, sampledMb: 700, ownTicks, peakStatus: "measured" }),
        PROFILE,
      )
      expect(row.peakStatus).toBe("unsampled")
      expect(row.peakMb).toBeNull()
      expect(row.sampledMb).toBe(700)
      expect(row.deltaMb).toBeNull()
      expect(row.ratio).toBeNull()
      expect(row.regressed).toBeNull()
    }
  })

  test("three owning ticks admit a peak, while a discard outranks thin sampling", () => {
    expect(classifyPeak(3, true, false)).toBe("measured")
    expect(classifyPeak(2, true, false)).toBe("unsampled")
    expect(classifyPeak(1, false, true)).toBe("discarded")
  })

  test("🔴 comparability is all-or-nothing across the derived fields", () => {
    const cases: ReadonlyArray<Observation> = [
      unit({ peakMb: 1200 }),
      unit({ peakMb: undefined }),
      unit({ name: "not-profiled" }),
      unit({ name: "not-profiled", peakMb: undefined }),
      unit({ peakMb: Number.NaN }),
    ]
    for (const observation of cases) {
      const row = buildRow(RUN, "default", observation, PROFILE)
      const derived = [row.deltaMb, row.ratio, row.regressed]
      const nulls = derived.filter((value) => value === null).length
      expect(nulls === 0 || nulls === derived.length).toBe(true)
      // And the derived fields are null exactly when an input is.
      expect(nulls === derived.length).toBe(row.peakMb === null || row.profileMb === null)
    }
  })

  test("a non-positive profile entry is treated as absent, never divided by", () => {
    const row = buildRow(RUN, "default", unit(), { core: 0 })
    expect(row.profileMb).toBeNull()
    expect(row.ratio).toBeNull()
  })

  test("a sharded run records its shard count; a whole run records 1", () => {
    expect(buildRow(RUN, "default", unit({ shards: 4 }), PROFILE).shards).toBe(4)
    expect(buildRow(RUN, "default", unit(), PROFILE).shards).toBe(1)
  })

  test("🔴 a scoped run is distinguishable from a full one", () => {
    // Averaging a --only= run into a full-gate series would answer the accumulation question with
    // measurements taken under different neighbours, which is the one reading the file must prevent.
    expect(scopeLabel(false, undefined)).toBe("default")
    expect(scopeLabel(true, undefined)).toBe("full")
    expect(scopeLabel(false, "schema")).toBe("only=schema")
    // --only= wins even alongside --full: bun run test --full --only=core runs one unit, not twenty.
    expect(scopeLabel(true, "core")).toBe("only=core")
    expect(new Set([scopeLabel(false, undefined), scopeLabel(true, undefined), scopeLabel(false, "core")]).size).toBe(3)
  })

  test("typecheck units are not emitted — they are never sampled, so they carry no information", () => {
    const rows = buildRows(
      RUN,
      "default",
      [unit(), { name: "typecheck:core", kind: "typecheck", ok: true, ms: 8000 }, unit({ name: "schema" })],
      PROFILE,
    )
    expect(rows.map((r) => r.unit)).toEqual(["core", "schema"])
  })

  test("every row of one invocation shares the run stamp, so a run is one grep", () => {
    const rows = buildRows(RUN, "full", [unit(), unit({ name: "schema", peakMb: 700 })], PROFILE)
    expect(new Set(rows.map((r) => r.run))).toEqual(new Set([RUN]))
    expect(new Set(rows.map((r) => r.scope))).toEqual(new Set(["full"]))
  })

  test("JSONL: one parseable object per line, trailing newline so `>>` stays well-formed", () => {
    const rows = buildRows(RUN, "default", [unit(), unit({ name: "schema", peakMb: 700 })], PROFILE)
    const text = format(rows)
    expect(text.endsWith("\n")).toBe(true)
    const lines = text.split("\n").filter(Boolean)
    expect(lines.length).toBe(2)
    expect(lines.map((line) => JSON.parse(line))).toEqual(rows.map((row) => JSON.parse(JSON.stringify(row))))
    // No embedded newline can split one row across two lines — unit names are free text.
    const weird = format([buildRow(RUN, "default", unit({ name: "a\nb" }), PROFILE)])
    expect(weird.split("\n").filter(Boolean).length).toBe(1)
  })

  test("format of nothing is still well-formed input for a reader", () => {
    expect(format([]).trim()).toBe("")
  })

  test("🔴 the series lands under tmp/, which the app repo gitignores", () => {
    const path = seriesPath("/repo").replaceAll("\\", "/")
    expect(path).toBe("/repo/tmp/peak-series.jsonl")
  })
})
