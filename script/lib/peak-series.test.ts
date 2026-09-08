import { describe, expect, test } from "bun:test"
import {
  buildRow,
  buildRows,
  classifyPeak,
  CONTAMINATED_FOREIGN_MB,
  CONTAMINATED_HOST_COMMIT_PCT,
  format,
  regressionVerdict,
  scopeLabel,
  seriesPath,
  type Observation,
} from "./peak-series"

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

describe("hostCommitPct — recording what the BOX was doing", () => {
  /**
   * 🔴 The gate computed this on every unit and threw it away, printing it only when a unit was
   * already killed. So a unit that passed green at 96% commit — one bad neighbour from the
   * 2026-07-20 OOM that took the laptop down — recorded nothing, and `test.ts`'s own instruction to
   * "enable a kill only after these lines have been observed across several full gates" could never
   * be met by anyone. Enforcement cannot be justified against a signal nobody kept.
   */
  test("a reading is carried onto the row", () => {
    expect(buildRow(RUN, "default", unit({ peakMb: 1500, hostCommitPct: 82 }), PROFILE).hostCommitPct).toBe(82)
  })

  test("🔴 an ABSENT reading is null, never 0 — 0% is a claim about an idle machine", () => {
    // ⚠️ Most of the existing file predates this column. A reader aggregating with `?? 0` would
    // invent a population of idle-machine rows; that exact coercion produced a false "peak 16 GB at
    // working set 0" finding on 2026-08-12, which matched a real zombie-process signature closely
    // enough to be believed. Null is the only honest value for "not recorded".
    expect(buildRow(RUN, "default", unit({ peakMb: 1500 }), PROFILE).hostCommitPct).toBeNull()
  })

  test("a genuine 0 survives, so the null above means absent and nothing else", () => {
    // Negative control: without this, returning null for everything would pass the test above.
    expect(buildRow(RUN, "default", unit({ peakMb: 1500, hostCommitPct: 0 }), PROFILE).hostCommitPct).toBe(0)
  })
})

/**
 * 🔴 Arming the ratchet. `regressed` was written to the series and never read by the gate, so a real
 * regression changed nothing about the run.
 *
 * The withholding branch is not caution for its own sake: the 1616-run audit's 4 fires (0.2%)
 * included two measured beside up to 6.8 GB of FOREIGN memory with 14–22 owning ticks — attribution
 * under host load. And the contamination line is 85%, chosen from the measured HEALTHY distribution
 * (316 rows, 26 gates): only `core` ever reaches 75 and it does so on 13 of 25 healthy runs, so 75
 * describes normal rather than trouble.
 */
describe("regressionVerdict — armed, with the withholding branch", () => {
  const row = (over: Partial<ReturnType<typeof buildRow>>) => ({
    ...buildRow(RUN, "default", unit({ peakMb: 7755 }), PROFILE),
    ...over,
  })

  test("a clean regressed sample is REGRESSED — this is the arming", () => {
    const verdict = regressionVerdict(row({ hostCommitPct: 52, foreignMb: 40 }))
    expect(verdict.verdict).toBe("regressed")
    expect(verdict.reason).toBe("")
  })

  test("a non-regressed row is clean whatever the host was doing", () => {
    // ⚠️ Contamination must never invent a verdict. It only ever WITHHOLDS one.
    const quiet = buildRow(RUN, "default", unit({ peakMb: 1200 }), PROFILE)
    expect(regressionVerdict({ ...quiet, hostCommitPct: 99, foreignMb: 90_000 }).verdict).toBe("clean")
  })

  test("host commit at or above the line withholds, and one point below it does not", () => {
    expect(regressionVerdict(row({ hostCommitPct: CONTAMINATED_HOST_COMMIT_PCT })).verdict).toBe("withheld")
    // The boundary matters: core's healthy median is 75 and its healthy max is 80, so 84 must still
    // count as a real sample or the ratchet is disarmed on the one unit it exists to watch.
    expect(regressionVerdict(row({ hostCommitPct: CONTAMINATED_HOST_COMMIT_PCT - 1, foreignMb: 10 })).verdict).toBe(
      "regressed",
    )
    expect(regressionVerdict(row({ hostCommitPct: 80, foreignMb: 10 })).verdict).toBe("regressed")
  })

  test("heavy foreign memory withholds, and the reason NAMES the number", () => {
    // The measured shape of two of the four historical fires (~6.8 GB).
    const verdict = regressionVerdict(row({ hostCommitPct: 60, foreignMb: 6800, peakMb: 6000 }))
    expect(verdict.verdict).toBe("withheld")
    expect(verdict.reason).toContain("6800")
  })

  test("🔴 the HARNESS's own shim is not contamination", () => {
    // The rule was first "foreign >= the unit's own peak", and firing it caught that: `bun run test`'s
    // shim is ~1 230 MB on EVERY run, so that rule withheld 28% of all rows and disarmed the ratchet
    // for every unit lighter than the harness. A threshold that fires on the normal case is not a
    // threshold.
    expect(regressionVerdict(row({ hostCommitPct: 52, foreignMb: 1230, peakMb: 836 })).verdict).toBe("regressed")
    expect(regressionVerdict(row({ hostCommitPct: 52, foreignMb: CONTAMINATED_FOREIGN_MB - 1 })).verdict).toBe(
      "regressed",
    )
    expect(regressionVerdict(row({ hostCommitPct: 52, foreignMb: CONTAMINATED_FOREIGN_MB })).verdict).toBe("withheld")
  })

  test("missing signals do NOT withhold — absent is not contaminated", () => {
    // ⚠️ The trap this closes: `hostCommitPct` is null on every row written before the field existed,
    // and treating null as "possibly contaminated" would silently disarm the ratchet for all of them.
    expect(regressionVerdict(row({ hostCommitPct: null, foreignMb: null })).verdict).toBe("regressed")
  })
})

/**
 * ─── the FOURTH null: a window that overlapped another run unit ────────────────────────────────
 *
 * Added with the concurrent runner (2026-09-02). Attribution is by process birth time, which is
 * exact for one unit at a time and wrong by construction for two: a neighbour's `bun` is also born
 * inside this unit's window. The danger is not the wrong number, it is where the wrong number goes —
 * `peakMb` is what a reader promotes into `test-baseline.json`'s `peaks`, i.e. the input to the
 * sharding ladder.
 */
describe("a concurrent window measures the POOL, not the unit", () => {
  test("🔴 `overlapped` outranks `discarded` — a pool of two easily sums past the 32 GB ceiling", () => {
    // Reporting that as `discarded` would dress a design decision up as a suspicious reading.
    expect(classifyPeak(500, false, true, true)).toBe("concurrent")
    expect(classifyPeak(500, true, false, true)).toBe("concurrent")
    expect(classifyPeak(500, true, false, false)).toBe("measured")
  })

  test("🔴 a concurrent row withholds `peakMb`, so nothing here can be promoted into the profile", () => {
    const row = buildRow(RUN, "full", unit({ peakMb: 21_000, sampledMb: 21_000, peakStatus: "concurrent" }), PROFILE)
    expect(row.peakStatus).toBe("concurrent")
    expect(row.peakMb).toBeNull()
    // The reading is KEPT — it is the pool's cost, which is the number that validates the budget.
    expect(row.sampledMb).toBe(21_000)
    // …and with no peak there is no ratio, so the ratchet cannot fire on a neighbour's memory.
    expect(row.ratio).toBeNull()
    expect(row.regressed).toBeNull()
    expect(regressionVerdict(row).verdict).toBe("clean")
  })
})

/**
 * ─── the FIFTH null: a run that had to SHARD ───────────────────────────────────────────────────
 *
 * This one was a live red rather than a design gap. Shards run sequentially, so each window carries
 * the previous shard's unreclaimed memory: `core` reads a median 10,117 / max 17,833 MB split
 * against a 10,822 MB whole-run maximum. That reading reached the armed ratchet — whose fire line
 * for `core` is 10,822 * 1.5 + 256 = 16,489 — so a memory-poor gate could be failed by the very
 * mitigation that let it run at all, under a message reading "a CLEAN sample".
 *
 * A ratchet a legitimate run cannot satisfy is worse than no ratchet: it trains its readers to
 * ignore a red. And the withholding is only half the point — the other half is that a sharded
 * number promoted into `peaks` makes the planner shard that unit forever.
 */
describe("a sharded window measures the unit PLUS the previous shard", () => {
  test("🔴 the ratchet cannot fire on a split run — the false red this closes", () => {
    // core's real numbers: profile 10,822, a split window reading 17,833, host commit and foreign
    // memory both perfectly healthy, so NEITHER existing contamination signal withholds it.
    const row = buildRow(
      RUN,
      "default",
      unit({ peakMb: 17_833, sampledMb: 17_833, shards: 4, hostCommitPct: 80, foreignMb: 1_230, ownTicks: 500 }),
      { core: 10_822 },
    )
    expect(row.peakStatus).toBe("sharded")
    expect(row.peakMb).toBeNull()
    expect(row.regressed).toBeNull()
    expect(regressionVerdict(row).verdict).toBe("clean")
  })

  test("NEGATIVE CONTROL — the identical reading from a WHOLE run still fires", () => {
    // Byte-identical but for `shards`. Without this the test above would pass against a ratchet that
    // had simply been disarmed, which is the failure it exists to prevent.
    const row = buildRow(
      RUN,
      "default",
      unit({ peakMb: 17_833, sampledMb: 17_833, hostCommitPct: 80, foreignMb: 1_230, ownTicks: 500 }),
      { core: 10_822 },
    )
    expect(row.peakStatus).toBe("measured")
    expect(row.peakMb).toBe(17_833)
    expect(row.regressed).toBe(true)
    expect(regressionVerdict(row).verdict).toBe("regressed")
  })

  test("🔴 the reading is KEPT — withheld from `peakMb`, never thrown away", () => {
    const row = buildRow(RUN, "default", unit({ peakMb: 17_833, sampledMb: 17_833, shards: 4 }), PROFILE)
    expect(row.sampledMb).toBe(17_833)
    expect(row.shards).toBe(4)
    // …and nothing derived survives, so no reader can reconstruct a comparison from the row.
    expect(row.deltaMb).toBeNull()
    expect(row.ratio).toBeNull()
  })

  test("🔴 the guarantee is the MODULE's, not its caller's", () => {
    // `test.ts` classifies before it calls, but a caller that does not — an older row shape, a rig,
    // a future second caller — must not be able to smuggle a split reading into `peakMb`. The shard
    // count on the observation is enough on its own.
    const row = buildRow(RUN, "default", unit({ peakMb: 17_833, shards: 4, peakStatus: "measured" }), PROFILE)
    expect(row.peakMb).toBeNull()
    expect(row.peakStatus).toBe("sharded")
  })

  test("classifyPeak: a split run outranks `discarded`, and `concurrent` outranks it", () => {
    // A split reading clears the implausibility ceiling on its own, so `discarded` would report a
    // KNOWN inflation as a suspicious one and send the reader hunting for a stray that is not there.
    expect(classifyPeak(500, false, true, false, 4)).toBe("sharded")
    expect(classifyPeak(500, true, false, false, 4)).toBe("sharded")
    // A pool window cannot be attributed at all, which is the stronger statement of the two.
    expect(classifyPeak(500, true, false, true, 4)).toBe("concurrent")
    // …and one shard is a whole run, so the ordinary path is untouched.
    expect(classifyPeak(500, true, false, false, 1)).toBe("measured")
    expect(classifyPeak(500, true, false, false, undefined)).toBe("measured")
    expect(classifyPeak(500, true, false)).toBe("measured")
  })
})
