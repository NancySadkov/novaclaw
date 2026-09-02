/**
 * The per-unit peak-vs-profile delta, kept as a SERIES instead of an anecdote.
 *
 * ─── why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * `test.ts` already MEASURES this. Its `── peak memory (MB) ──` block compares each unit's sampled
 * peak against `test-baseline.json`'s hand-maintained `peaks` profile and prints a verdict — it once
 * printed `core 7755` against a 1 007 MB profile with *"that is a real jump, look at it"* beside it.
 * The detector is not the gap. The gap is that the print is **per-run and ephemeral**, so the only
 * question anybody actually wants answered — *does gate degradation accumulate across consecutive
 * runs?* — has never had more than one data point at a time to answer it with.
 *
 * So this module does not detect anything. It appends what the detector already found, one row per
 * unit per run, and the accumulation question becomes a `grep` over a file.
 *
 * ─── three decisions worth stating, because each one has a way of being got wrong ───────────────
 *
 *  1. **The verdict is imported, never re-derived.** `regressed` comes from `MemoryPlan.peakRegressed`
 *     — the same predicate the printed block uses. A series that disagreed with the line printed
 *     beside it would be two answers to one question, which is exactly the shape `ledger-drift.ts`
 *     exists to record as a mistake we have already made once.
 *  2. **Scope rides every row.** A `--only=schema` run and a full gate are not points on the same
 *     series: the unit ran with a different set of neighbours, and neighbours are the whole subject
 *     when the question is about accumulation. A reader who cannot tell them apart will average them.
 *  3. **A missing peak is `null`, not an absent row.** `test.ts` DISCARDS an implausible sample (a
 *     stray `bun` inflated `core` to 12 014 MB once), and a sharded or crashed unit can produce none
 *     at all. Dropping those rows would make a run with an unmeasurable unit look like a run where
 *     that unit was fine; a null says which.
 *
 * ⚠️ **Nothing here may fail the gate.** Writing a log is not the gate's job, and an instrument that
 * can take down the thing it measures is worse than no instrument. `append` reports its failure as a
 * value and `test.ts` prints it as a warning — the same rule the logging program states for the
 * instance ("logging must never take the instance down"), applied to the gate itself.
 *
 * ⚠️ **This module never writes `test-baseline.json`.** The profile stays hand-maintained on purpose:
 * an auto-updating baseline ratchets to whatever the machine did last, which is the opposite of a
 * profile. This is an observation log *beside* it.
 */
import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"

import { peakRegressed } from "./memory-plan"

/** One unit's outcome, as much of it as a series row needs. `test.ts`'s `Result` satisfies this. */
export interface Observation {
  readonly name: string
  readonly kind: "test" | "typecheck"
  readonly ok: boolean
  readonly ms: number
  /** Absent when nothing was sampled, the reading was discarded, or fewer than three owning ticks observed it. */
  readonly peakMb?: number
  /** Which of those two it was. Absent on rows built before the distinction existed. */
  readonly peakStatus?: PeakStatus
  /** What the sampler read, including a reading `peakMb` refused. */
  readonly sampledMb?: number
  /** Resident working-set peak measured beside commit. */
  readonly workingSetMb?: number
  /** Peak MB the sampler EXCLUDED as not belonging to this unit (the shim, a stray, a dying child). */
  readonly foreignMb?: number
  /** Ticks that saw a process belonging to this unit. Absent on rows built before attribution. */
  readonly ownTicks?: number
  /**
   * Worst host commit charge (% of the machine's limit) reached while this unit ran.
   *
   * ⚠️ The point is the HEALTHY runs. A breach was only ever mentioned when a unit had already been
   * killed, so a unit that passed green at 96% — one bad neighbour from the 2026-07-20 OOM that took
   * the laptop down — recorded nothing. Enforcement cannot be justified against a signal nobody kept.
   */
  readonly hostCommitPct?: number
  /** Absent unless memory pressure forced the degraded rung. */
  readonly shards?: number
}

/**
 * Why a row has no `peakMb`.
 *
 * 🔴 **This is the field the file was missing, and its absence cost three gates.** `core` wrote
 * `peakMb: null` on 2026-08-07 at 06:28, 07:26 and 10:02, and every reader took that for "the
 * sampler saw nothing". It was `discarded`: 565 ticks, peak **16 758 MB** against a **1 007 MB**
 * profile. A null that means *nothing was observed* and a null that means *17 GB was observed and
 * rejected* are opposite facts, and the second is the finding.
 *
 * 🔴 **`concurrent` is the FOURTH null, added 2026-09-02 with the concurrent runner, and it is the
 * honest answer to a question the sampler structurally cannot answer any more.** Attribution is by
 * process BIRTH TIME against the unit's window (`peak-sampler.ts`): a `bun` born after the window
 * opened is the unit's. That test is exact while one unit runs at a time and *wrong by construction*
 * once two do — every process the neighbour spawns is also born inside this unit's window, so the
 * reading is the POOL's cost wearing one unit's name. It would then feed `test-baseline.json`'s
 * `peaks`, which is the input to the sharding ladder: a unit would be recorded at its neighbours'
 * expense and shard forever afterwards. That is the exact loop the 2026-08-13 re-baseline closed,
 * and re-opening it silently is worse than losing the reading.
 *
 * So a unit that overlapped another reports `concurrent`, keeps its raw `sampledMb` (which now means
 * *the pool*, and is labelled as such wherever it prints), and withholds `peakMb`. ⚠️ **The profile
 * is therefore refreshed by SOLO runs** — `--only=<unit>`, or `NOVACLAW_TEST_CONCURRENCY=1` — which
 * is not a regression in what the gate knows so much as a relocation of where it learns it. Closing
 * the gap properly needs a per-process PARENT column in the timeline so a pool can be un-mixed;
 * that is a bigger change to an instrument with a long history of subtle bugs, and it wants its own
 * measurement rather than a ride on this one.
 *
 * 🔴 **`sharded` is the FIFTH null, and it was a live RED before it was a status.** A sharded window
 * measures the unit PLUS the previous shard's memory, not yet reclaimed — `core`: 25 whole runs
 * median 10,198 / max 10,822 against 232 split runs median 10,117 / **max 17,833**, 88 of them above
 * the profile. That reading was being recorded as `measured`, which put it in front of the peak
 * ratchet with `peaks.core = 10822` and a fire line at 16,489 MB: **a memory-poor gate that had to
 * shard could fail on its own mitigation**, and the failure text printed *"a CLEAN sample"* over the
 * one composition this file's own data says reads high. A ratchet a legitimate run cannot satisfy
 * teaches everyone to ignore a red, which costs more than the ratchet was ever worth.
 *
 * It is the same shape as `concurrent` and takes the same treatment: keep `sampledMb`, withhold
 * `peakMb`. That is also what stops the OTHER half — a sharded reading promoted into `peaks` makes
 * the planner shard the unit forever, the loop the 2026-08-13 re-baseline closed by hand. The rule
 * was already written down in three places ({@link Row.shards}, `test-baseline.json`'s `peaksNote`,
 * `test.ts`'s printed *"do not promote it"*); it just was not mechanical anywhere.
 */
export type PeakStatus = "measured" | "discarded" | "unsampled" | "concurrent" | "sharded"

/** Fewer observations can only establish a lower bound, never the unit's peak. */
export const MIN_RECORDED_OWN_TICKS = 3

export function classifyPeak(
  ownTicks: number,
  hasMeasuredPeak: boolean,
  hasDiscardedSample: boolean,
  /** Another run unit was in flight for part of this window — see {@link PeakStatus}. */
  overlapped = false,
  /** How many shards the unit was split into. 1 (or undefined) is a whole run. */
  shards: number | undefined = 1,
): PeakStatus {
  // FIRST, and ahead of `discarded`: a pool of two units easily sums past the 32 GB implausibility
  // ceiling, and reporting that as `discarded` would describe a known-unattributable reading as a
  // suspicious one — a finding invented out of a design decision.
  if (overlapped) return "concurrent"
  // SECOND, and also ahead of `discarded`, for the same reason one rung down: a split run's reading
  // carries the previous shard's unreclaimed memory and has been measured up to 17,833 MB against a
  // 10,822 MB whole-run maximum, which clears the implausibility ceiling on its own. Calling that
  // `discarded` would report a KNOWN inflation as a suspicious reading and send the reader hunting.
  if ((shards ?? 1) > 1) return "sharded"
  if (hasDiscardedSample) return "discarded"
  if (ownTicks < MIN_RECORDED_OWN_TICKS) return "unsampled"
  return hasMeasuredPeak ? "measured" : "unsampled"
}

export interface Row {
  /** The RUN stamp — identical across every row of one invocation, so a run is one `grep`. */
  readonly run: string
  /** `"default"` · `"full"` · `"only=<x>"`. Rows from different scopes are not comparable. */
  readonly scope: string
  readonly unit: string
  readonly kind: "test" | "typecheck"
  readonly ok: boolean
  readonly ms: number
  /**
   * 1 for a whole run.
   *
   * ⚠️ **A sharded peak does NOT measure close to the whole — it measures HIGH.** Shards run
   * sequentially, so the previous shard's memory is not yet reclaimed inside the next shard's
   * window. For `core`: 18 whole runs median 10,235 MB / max 10,822, against 168 sharded runs
   * median 12,936 / max 17,833. Never promote a `shards > 1` row into `peaks` —
   * `test-baseline.json`'s `peaksNote` excludes them by rule, and feeding one back is what kept
   * `core` permanently sharded.
   *
   * 🔴 **That rule is now MECHANICAL, not advice:** `shards > 1` forces `peakStatus: "sharded"` and
   * a null `peakMb`, so there is nothing on the row for a reader or a ratchet to mistake for a
   * whole-run figure. The raw reading survives as {@link sampledMb}, labelled.
   */
  readonly shards: number
  /**
   * Observed peak, or null when nothing believable was sampled. `peakStatus` says which.
   *
   * 🔴 **The invariant: this is non-null only for a SOLO, WHOLE, adequately sampled run.** It is the
   * field a reader promotes into `test-baseline.json`'s `peaks` and the only field the peak ratchet
   * fires on, so every composition that measures something other than the unit's own demand —
   * a pool window, a split run, one or two owning ticks, a discard — nulls it here rather than
   * hoping the consumer remembers to check.
   */
  readonly peakMb: number | null
  /**
   * `measured` | `discarded` | `unsampled` | `concurrent` | `sharded` — never infer this from
   * `peakMb === null`.
   */
  readonly peakStatus: PeakStatus
  /**
   * The raw sampled figure, present even when it was rejected. Null when nothing was sampled.
   *
   * ⚠️ On a `concurrent` row this is the POOL's cost, not the unit's — every neighbour's processes
   * were born inside this unit's window too. Comparable across concurrent rows of the same run;
   * never comparable with a solo row, and never promotable into `peaks`.
   */
  readonly sampledMb: number | null
  /** Resident working-set peak for the same attributed process set. */
  readonly workingSetMb: number | null
  /**
   * What the window excluded as not this unit's, in MB. Null on a row built before attribution.
   *
   * 🔴 **This column is what makes the series comparable across 2026-08-07.** Every `peakMb` written
   * before that date silently included the `bun run test` parent shim (41–45 MB), and `core`'s
   * included its own sixteen flock workers. A reader averaging old rows with new ones is averaging
   * two different measurements; a non-null `foreignMb` is the marker that says which side a row is on.
   */
  readonly foreignMb: number | null
  /**
   * How many 200 ms ticks actually saw one of this unit's processes. Null before attribution.
   *
   * ⚠️ **Fewer than three owning ticks are a lower bound, not a peak.** Such rows retain the raw
   * `sampledMb`, but `peakMb` is null so chance timing cannot masquerade as a measurement. This is the
   * column that would have exposed `schema: 43` as an artefact instead of a measurement.
   */
  readonly ownTicks: number | null
  /**
   * Worst host commit charge (% of limit) reached while this unit ran. Null on rows written before
   * this column existed — which is MOST of the file, so filter on presence rather than treating a
   * missing reading as 0%.
   */
  readonly hostCommitPct: number | null
  /** The hand-maintained profile figure, or null when this unit is not in it yet. */
  readonly profileMb: number | null
  /** `peakMb - profileMb`, in MB. Null whenever either side is. */
  readonly deltaMb: number | null
  /** `peakMb / profileMb`, 3 dp. Null whenever either side is. */
  readonly ratio: number | null
  /** `MemoryPlan.peakRegressed` — the SAME verdict the run printed. Null when it has no inputs. */
  readonly regressed: boolean | null
}

/**
 * How this invocation was scoped.
 *
 * A plain string rather than a tagged union because the file is read by people with `grep` at least
 * as often as by code, and `"only=schema"` is legible where `{"scope":"only","unit":"schema"}` is a
 * second thing to explain.
 */
export const scopeLabel = (full: boolean, only: string | undefined): string =>
  only !== undefined ? `only=${only}` : full ? "full" : "default"

/** The series file. Under `tmp/`, which the app repo gitignores — the gate writes no tracked artifact. */
export const seriesPath = (repoRoot: string): string => join(repoRoot, "tmp", "peak-series.jsonl")

const round3 = (n: number) => Math.round(n * 1000) / 1000

/** One row. Pure: every derived field is a function of the two numbers above it. */
export function buildRow(
  run: string,
  scope: string,
  observation: Observation,
  profile: Readonly<Record<string, number>>,
): Row {
  const observedPeakMb = Number.isFinite(observation.peakMb) ? (observation.peakMb as number) : null
  const ownTicks = Number.isFinite(observation.ownTicks) ? (observation.ownTicks as number) : null
  const thinSample = ownTicks !== null && ownTicks < MIN_RECORDED_OWN_TICKS && observation.peakStatus !== "discarded"
  // An overlapped window measured the POOL, not the unit. It must never reach `peakMb`, because
  // `peakMb` is what a reader promotes into the profile the sharding ladder plans from.
  const concurrent = observation.peakStatus === "concurrent"
  // 🔴 And a split window measured the unit PLUS the previous shard — read off `observation.shards`
  // rather than trusting `peakStatus`, so the guarantee is this MODULE's and not its caller's. A
  // caller that forgets to classify still cannot get a sharded number into `peakMb`, which is the
  // field the ratchet fires on and the field a reader promotes into `peaks`.
  const shards = observation.shards ?? 1
  const sharded = shards > 1 || observation.peakStatus === "sharded"
  const peakMb = thinSample || concurrent || sharded ? null : observedPeakMb
  const fromProfile = profile[observation.name]
  // A zero or negative profile entry is not a baseline, it is a typo — treat it as absent rather than
  // dividing by it. `readPeaks()` already filters these out; this holds if that ever stops being true.
  const profileMb =
    typeof fromProfile === "number" && Number.isFinite(fromProfile) && fromProfile > 0 ? fromProfile : null
  const comparable = peakMb !== null && profileMb !== null
  const sampledMb = Number.isFinite(observation.sampledMb) ? (observation.sampledMb as number) : null
  // Derived, never guessed: a caller that predates the field still gets a row that is TRUE, because
  // "there is a peak" does imply it was measured. Only the two no-peak cases need telling apart, and
  // a caller who cannot tell them apart says `unsampled` — the weaker, non-alarming claim.
  const peakStatus: PeakStatus = concurrent
    ? "concurrent"
    : sharded
      ? "sharded"
      : thinSample
        ? "unsampled"
        : (observation.peakStatus ?? (peakMb !== null ? "measured" : "unsampled"))
  return {
    run,
    scope,
    unit: observation.name,
    kind: observation.kind,
    ok: observation.ok,
    ms: observation.ms,
    shards,
    peakMb,
    peakStatus,
    sampledMb,
    workingSetMb: Number.isFinite(observation.workingSetMb) ? (observation.workingSetMb as number) : null,
    foreignMb: Number.isFinite(observation.foreignMb) ? (observation.foreignMb as number) : null,
    ownTicks,
    hostCommitPct: Number.isFinite(observation.hostCommitPct) ? (observation.hostCommitPct as number) : null,
    profileMb,
    deltaMb: comparable ? peakMb - profileMb : null,
    ratio: comparable ? round3(peakMb / profileMb) : null,
    regressed: comparable ? peakRegressed(profileMb, peakMb) : null,
  }
}

/**
 * ─── ARMING the peak ratchet ────────────────────────────────────────────────────────────────────
 *
 * `regressed` has been REPORTED and never enforced, with a stated follow-up: *"arming is a
 * follow-up that wants a few runs of data first"*, and specifically — check whether regressed rows
 * coincide with high host commit; if so withhold the verdict on contaminated samples, if not arm as
 * it stands.
 *
 * 🔴 **Measured 2026-08-12 over 316 rows across 26 gates carrying `hostCommitPct`: ZERO regressed
 * rows.** So the conditional is UNANSWERABLE, not answered — and "arm as it stands" on that basis
 * would be reading a null as a negative. What the older 1616-run audit did establish is that the
 * threshold would have failed 4 rows (0.2%), and **two of those carried up to 6.8 GB of FOREIGN
 * memory beside 14–22 owning ticks** — attribution under host load, not a real regression.
 *
 * So the verdict is armed WITH the withholding branch, because that is the branch the evidence
 * actually supports. A sample is contaminated when either signal says another process was competing:
 *
 *  · `hostCommitPct` at or above {@link CONTAMINATED_HOST_COMMIT_PCT}. Chosen from the measured
 *    HEALTHY distribution rather than from the product's storage thresholds: across those 316 rows
 *    only `core` ever reaches 75% and it does so on **13 of 25 healthy runs** — its median IS 75 — so
 *    75 is a description of normal, not of trouble. No unit has ever reached 90.
 *  · `foreignMb` at or above {@link CONTAMINATED_FOREIGN_MB}. ⚠️ This was first written as *"foreign
 *    at or above the unit's own PEAK"*, which is wrong and was caught by firing it: `bun run test`'s
 *    own shim is ~1 230 MB on every run — the report even names it — so that rule withheld 28% of all
 *    rows, i.e. it disarmed the ratchet for every unit lighter than the harness. The absolute cut is
 *    read off the distribution instead, which is sharply BIMODAL over 2 130 rows: median 50 MB,
 *    p90 6 763 MB, and fewer than 1% of rows anywhere between 2 000 and 6 000. Any threshold inside
 *    that gap gives the same partition, which is the point — the number is insensitive, so it is a
 *    reading of the data rather than a choice.
 *
 * ⚠️ **A withheld verdict is printed, never swallowed.** The whole failure mode this replaces is a
 * number that vanishes; "we saw a regression and are not counting it" must be as loud as counting it,
 * or the next reader cannot tell a clean history from a suppressed one.
 *
 * ⚠️ **A SHARDED run is not on this list, and that is deliberate — it is handled one layer earlier.**
 * A third contamination signal here would have been the obvious fix and the wrong rung: withholding
 * a verdict leaves the inflated number sitting in `peakMb`, where the next reader promotes it into
 * `peaks` and the unit shards forever. {@link buildRow} nulls `peakMb` for a split run instead, so
 * `regressed` is null and this function reaches `clean` without needing to know what a shard is.
 */
export const CONTAMINATED_HOST_COMMIT_PCT = 85
export const CONTAMINATED_FOREIGN_MB = 3000

export type RegressionVerdict = "clean" | "regressed" | "withheld"

/** Why a verdict was withheld — one short clause for the report, empty when it was not. */
export const regressionVerdict = (row: Row): { readonly verdict: RegressionVerdict; readonly reason: string } => {
  if (row.regressed !== true) return { verdict: "clean", reason: "" }
  if (row.hostCommitPct !== null && row.hostCommitPct >= CONTAMINATED_HOST_COMMIT_PCT)
    return { verdict: "withheld", reason: `host commit peaked ${row.hostCommitPct}% while this unit ran` }
  if (row.foreignMb !== null && row.foreignMb >= CONTAMINATED_FOREIGN_MB)
    return {
      verdict: "withheld",
      reason: `${row.foreignMb} MB of foreign memory beside a ${row.peakMb ?? "?"} MB peak`,
    }
  return { verdict: "regressed", reason: "" }
}

/**
 * Rows for one run.
 *
 * ⚠️ **Test units only.** A typecheck unit is never sampled at all (`test.ts` takes a window only for
 * `kind === "test"`), so including them would append sixteen all-null rows per run — noise that makes
 * the file harder to read and says nothing. `kind` still rides each row so a typecheck row would be
 * unambiguous if that ever changes.
 */
export const buildRows = (
  run: string,
  scope: string,
  observations: readonly Observation[],
  profile: Readonly<Record<string, number>>,
): Row[] => observations.filter((o) => o.kind === "test").map((o) => buildRow(run, scope, o, profile))

/** JSONL: one row per line, trailing newline, so a plain `>>` append is well-formed. */
export const format = (rows: readonly Row[]): string => rows.map((row) => JSON.stringify(row)).join("\n") + "\n"

export type AppendOutcome =
  | { readonly ok: true; readonly path: string; readonly rows: number }
  | { readonly ok: false; readonly path: string; readonly reason: string }

/**
 * Append the rows, or say why not.
 *
 * 🔴 **Never throws.** A full disk, a locked file, a `tmp/` that could not be created — every one of
 * them degrades to a returned reason. The gate's exit code is about the tests, and it must not
 * acquire a new way to go red that has nothing to do with them.
 */
export function append(path: string, rows: readonly Row[]): AppendOutcome {
  if (rows.length === 0) return { ok: true, path, rows: 0 }
  try {
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, format(rows), "utf8")
    return { ok: true, path, rows: rows.length }
  } catch (error) {
    return { ok: false, path, reason: error instanceof Error ? error.message : String(error) }
  }
}
