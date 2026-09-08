/**
 * How much memory a run unit needs, and what to do when the machine has less.
 *
 * ─── why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * `heavy-guard.ts` refused any test run below a flat **6 GB of free RAM**, a number derived from the
 * 2026-07-27 incident in which a release build and the suite ran together. That incident's cause was
 * CONCURRENCY, which the guard catches with a different arm entirely — so the floor was a second,
 * blunt instrument sized from something it was not needed to prevent, and it was the arm that
 * actually blocked work.
 *
 * ⚠️ **And a refusal is not neutral.** The same day, the substitute for the refused gate — running
 * core's files in eight batches — was green in every batch while the unit as one process wedged for
 * ten minutes. The guard hid a real defect. That is the second reason to make the harness fit into
 * the memory it has rather than decline to run.
 *
 * ─── what this module decides ───────────────────────────────────────────────────────────────────
 *
 * A LADDER, per unit, from measured headroom against that unit's own recorded peak — never from a
 * constant. `whole` is the canonical result; `sharded` is a deliberately WEAKER one (see
 * {@link Plan}); `refuse` is what remains when even one shard cannot fit.
 *
 * ─── 🔴 the measurement this file used to quote is DEAD, and so is everything derived from it ────
 *
 * Every number below was originally justified by one sentence: *"`core`, the heaviest fast-tier
 * unit, peaks at ~1.0 GB run whole"* (2026-08-05). **That is false by ~17×.** The sampler summed
 * every `bun` on the box by NAME, so it could not tell a unit's own children from a stray — and
 * `core`'s two flock suites each spawn `const n = 16` workers with `process.execPath`, which under
 * `bun test` is `bun.exe`. Its reading was therefore thrown away against an 8 192 MB implausibility
 * ceiling on every gate, and the profile kept a 1 007 MB entry the instrument was structurally
 * unable to correct.
 *
 * Attribution is now by process **birth time** (app `2d6ad8db7`), re-derived on 2026-08-07 and then
 * **re-baselined whole on 2026-08-13** over the runs recorded in `tmp/peak-series.jsonl`. Each
 * re-derivation is stated where the constant is declared, so a dead premise cannot sit next to a
 * corrected number again.
 *
 * ⚠️ **The 16.4–18.0 GB figure this file used to quote for `core` is the SECOND dead premise.**
 * Those were SHARDED rows, and a shard's window carries the previous shard's unreclaimed memory —
 * feeding them back is what kept `core` permanently sharded. `test-baseline.json`'s `peaksNote`
 * settled it and set `peaks.core = 10822`, the largest healthy WHOLE-run reading as of that date.
 * Re-measured 2026-09-01 over the same series (44 healthy whole runs: `shards: 1`, not `regressed`,
 * ≥3 own ticks, carrying `foreignMb`): **7 921–16 310 MB commit, 2 422–7 971 MB resident.** Six of
 * the 44 exceed 10 822 and all six are 2026-08-25 runs taken at 74–85 % host commit — i.e. the box
 * was already full. That is a re-baseline question for the profile, not a licence to quote a
 * sharded number again.
 *
 * ─── two measurements, two walls ─────────────────────────────────────────────────────────────────
 *
 * App `b2b591b83` measured `core` at 16,552 MB commit / **4,616 MB resident** across 907 attributed
 * ticks — the commit half of that pair was a sharded row and is superseded by `peaks.core`; the
 * resident half is still what `workingSets.core` carries. Comparing a commit number to free
 * physical RAM made `core` permanently sharded even on an otherwise empty laptop. The planner now keeps both dimensions: commit demand meets Windows commit
 * headroom; resident demand meets immediately available RAM. Neither safety arm was removed — the
 * category error between them was.
 */

/** A unit's recorded peak, in MB. */
export type PeakProfile = Readonly<Record<string, number>>

export interface Demand {
  readonly commitPeakMb: number
  readonly residentPeakMb: number
}

export interface Headroom {
  readonly commitBytes: number
  readonly residentBytes: number
}

const MB = 1024 ** 2

/**
 * Headroom a unit needs beyond its own peak before it may run whole.
 *
 * 1.3× is retained; **its old justification is retired twice over.** The original was *"`core`
 * peaked at ~1.0 GB across five measurements that varied by under 3 %"* — a stability claim taken
 * from the dead 1 007 MB reading. Its replacement quoted the SHARDED 16 364–17 958 MB range, which
 * is the second dead premise (see the header). Measured 2026-09-01 over healthy WHOLE runs in
 * `tmp/peak-series.jsonl`: 44 `core` runs span **7 921–16 310 MB** and 439 `novaclaw:server` runs
 * span **436–3 828 MB**. Neither is anywhere near 3 %.
 *
 * What makes 1.3 defensible now is a different property of the profile: every entry is the
 * **largest** attributed reading for that unit, not a typical one. So the factor is covering
 * overshoot *beyond an observed maximum*, not the spread below it — and the slack below still
 * carries the fixed cost (the runner itself, bun's own startup) that scales with nothing.
 */
export const WHOLE_HEADROOM_FACTOR = 1.3

/** Fixed slack added to every requirement: the runner process, and room to not be at exactly zero. */
export const SLACK_BYTES = 512 * MB

/**
 * The floor below which nothing runs, sharded or not.
 *
 * 1200 MB is retained; **its old derivation is retired with the rest.** It used to read *"one shard
 * of `core` (~40 files) peaked at 1 007 MB, and the smallest observed unit peak is ~780 MB"* — both
 * halves are now false. No shard of `core` has ever been measured, and the smallest attributed
 * whole-unit peaks are `script` at **270 MB** and `ui` at **415 MB**.
 *
 * What supports the floor now is the attributed distribution: sixteen of the twenty units sit
 * between **415 and 1 000 MB**, which is a `bun` process carrying a module graph, an Effect runtime
 * and sqlite and very little else. 1200 MB is a little over that per-process baseline — below it,
 * nothing this harness spawns can start at all, so there is no split that helps.
 */
export const MIN_VIABLE_BYTES = 1200 * MB

/** What a unit is assumed to need when nothing has measured it yet. Deliberately generous. */
export const UNPROFILED_PEAK_MB = 1200
/** Resident default for a unit whose working-set peak has not been measured yet. */
export const UNPROFILED_RESIDENT_MB = 1200

/** Never split a unit into more shards than this — past it, per-process startup dominates. */
export const MAX_SHARDS = 8

/**
 * Above this, a peak sample is not a reading about the unit — see `test.ts`'s `spawnOnce`.
 *
 * ⚠️ **This lives here rather than in `test.ts` because it is a property of the PROFILE.** A ceiling
 * below an entry's true value silently discards the one reading that entry needs, and the profile
 * can then never be corrected — which is exactly what happened: 8 192 MB against a `core` whose real
 * readings start around 10 GB, discarded on four consecutive gates while the entry stayed at 1 007.
 * {@link unrecordableUnits} is the mechanical check that the pair can never drift apart again.
 *
 * ⚠️ **32 768 MB is a coarse backstop and must not be read as a fine filter.** Before attribution it
 * was doing sensitive work — rejecting any stray `bun` on the box. It no longer is: birth-time
 * attribution excludes every process older than the unit's window, so the fine-grained job is done
 * upstream. What is left for the ceiling is the class attribution structurally cannot see:
 *
 *   · a reading larger than the machine could physically hold (this box's commit limit is ~46 GB),
 *     which can only be broken arithmetic or a broken sampler;
 *   · a runaway or leaking harness process;
 *   · a large FOREIGN `bun` born *inside* a unit's window — the one attribution gap that remains.
 *
 * ⚠️ Be honest about what that costs: at 32 GB a sibling agent's `tsgo`/`bun` job (~3.8 GB) landing
 * inside `core`'s window would no longer be rejected. That is accepted deliberately — the old
 * ceiling "caught" it by throwing away the real reading too, which is strictly worse, and
 * `heavy-guard` independently refuses to start beside a second suite or a build.
 */
export const IMPLAUSIBLE_PEAK_MB = 32_768

export type Plan =
  | { readonly mode: "whole"; readonly commitRequiredBytes: number; readonly residentRequiredBytes: number }
  /**
   * ⚠️ **A WEAKER RESULT, and it must be reported as one.** Splitting a unit changes which files
   * share a process, and that changes behaviour: measured 2026-08-05, eight green batches over
   * `core` concealed a wedge that only exists when the unit runs whole, and `--shard=1/2` wedged
   * where the whole unit did not. A sharded pass is most of the signal, not the gate.
   */
  | {
      readonly mode: "sharded"
      readonly shards: number
      readonly commitRequiredBytes: number
      readonly residentRequiredBytes: number
    }
  | { readonly mode: "refuse"; readonly commitRequiredBytes: number; readonly residentRequiredBytes: number }

/** Bytes a unit with this peak needs free to run whole. */
export const requiredBytes = (peakMb: number): number => Math.round(peakMb * MB * WHOLE_HEADROOM_FACTOR) + SLACK_BYTES

/**
 * A unit's share of a POOL's budget — {@link requiredBytes} without the fixed slack.
 *
 * 🔴 **The difference is not a rounding preference; charging slack per unit is a category error once
 * more than one unit runs.** {@link SLACK_BYTES} is *"the runner process, and room to not be at
 * exactly zero"* — a cost of the harness, which does not multiply with the pool. Charged per
 * reservation it dominates the cheap units and quietly caps concurrency at one: `session-ui` peaks
 * at 122 MB resident and would reserve 671 MB, of which 512 is a second copy of the runner that does
 * not exist. The pool subtracts the slack ONCE from the budget instead (`RunSchedule.poolBudget`)
 * and hands out this figure.
 *
 * ⚠️ The 1.3× overshoot factor stays per unit, because that one IS per unit: it covers a unit
 * exceeding its own observed maximum, and two units can each do that independently.
 */
export const reservedBytes = (peakMb: number): number => Math.round(peakMb * MB * WHOLE_HEADROOM_FACTOR)

/**
 * Pick the rung.
 *
 * Both walls must clear independently. A machine can have free RAM and no commit left, or commit
 * headroom and no RAM; collapsing them through `min()` compares at least one demand to the wrong unit.
 */
export function planFor(demand: Demand, headroom: Headroom): Plan {
  const commitRequiredBytes = requiredBytes(demand.commitPeakMb)
  const residentRequiredBytes = requiredBytes(demand.residentPeakMb)
  const result = { commitRequiredBytes, residentRequiredBytes }
  if (!Number.isFinite(headroom.commitBytes) || !Number.isFinite(headroom.residentBytes))
    return { mode: "whole", ...result }
  if (headroom.commitBytes >= commitRequiredBytes && headroom.residentBytes >= residentRequiredBytes)
    return { mode: "whole", ...result }
  if (headroom.commitBytes < MIN_VIABLE_BYTES || headroom.residentBytes < MIN_VIABLE_BYTES)
    return { mode: "refuse", ...result }
  // Shards do not divide the requirement: the split buys the GC and fixture churn of a shorter-lived
  // process, not a proportionally smaller heap. Scale gently and cap, because a shard count derived
  // as `required/headroom` would promise a reduction that is not there.
  //
  // 🔴 **The premise this comment used to give — "peak is nearly flat in file count" — was quoted
  // from the dead 1 007 MB measurement, and the corrected data splits it in two.**
  //
  //   · **Accumulation.** Nineteen of twenty units are dominated by a per-process baseline
  //     (415–2 237 MB attributed) that grows slowly with the files sharing the process. For these
  //     the old sentence still holds and sharding buys a little — the gentle scaling above.
  //   · **Fan-out.** `core` is not that shape at all. The bulk of its peak is *sixteen* concurrent
  //     `bun` workers spawned by `test/util/flock.test.ts` and `util/effect-flock.test.ts`
  //     (`const n = 16`, `process.execPath`). Those live in ONE file, so they land in ONE shard —
  //     **splitting `core` does not lower its peak by a byte.** For a fan-out unit the sharded rung
  //     is inert: it reports DEGRADED, costs per-process startup, and mitigates nothing.
  //
  // ⚠️ The rung is left in place rather than special-cased, because the honest repair is not here:
  // it is either the 16-way fan-out itself (a test-side item — do not "fix" the measurement by
  // changing the thing measured) or the commit-vs-free-RAM yardstick described in this file's
  // header. What must not happen is this comment claiming a reduction the data says is absent.
  const pressure = Math.max(
    commitRequiredBytes / headroom.commitBytes,
    residentRequiredBytes / headroom.residentBytes,
  )
  const shards = Math.min(MAX_SHARDS, Math.max(2, Math.ceil(pressure)))
  return { mode: "sharded", shards, ...result }
}

/** The peak to plan with: what was measured for this unit, or the generous default. */
export const peakFor = (profile: PeakProfile, unit: string): number => profile[unit] ?? UNPROFILED_PEAK_MB

/** The dual demand for a unit; an absent resident observation stays an explicit conservative guess. */
export const demandFor = (commit: PeakProfile, resident: PeakProfile, unit: string): Demand => ({
  commitPeakMb: peakFor(commit, unit),
  residentPeakMb: resident[unit] ?? UNPROFILED_RESIDENT_MB,
})

/**
 * Units that would fit in the headroom we have — the actionable half of a refusal.
 *
 * A refusal that names only what is missing tells the user nothing they can do right now. This turns
 * it into "these still fit", which is a working command rather than a wait.
 */
export function unitsThatFit(
  commit: PeakProfile,
  resident: PeakProfile,
  units: readonly string[],
  headroom: Headroom,
): string[] {
  return units.filter((unit) => planFor(demandFor(commit, resident, unit), headroom).mode === "whole")
}

/**
 * Profile entries the instrument could never re-measure — i.e. at or above the discard ceiling.
 *
 * 🔴 **This is the mechanical check for the defect that produced this whole item.** `core` sat at
 * 1 007 MB while costing ~17 000, and the entry could not be corrected because every reading of it
 * was discarded against a ceiling below its true value. An entry the measurement cannot update is
 * worse than an absent one: an absent entry announces itself by planning with
 * {@link UNPROFILED_PEAK_MB}, whereas a stale one is indistinguishable from a fresh one.
 *
 * Returns the offending unit names, so a caller can say WHICH rather than only that something is
 * wrong. Empty means the two knobs are consistent.
 */
export function unrecordableUnits(profile: PeakProfile, ceilingMb: number = IMPLAUSIBLE_PEAK_MB): string[] {
  return Object.entries(profile)
    .filter(([, mb]) => mb >= ceilingMb)
    .map(([unit]) => unit)
    .sort()
}

/**
 * Whether an observed peak is far enough above its baseline to be worth saying out loud.
 *
 * ⚠️ Generous, and REPORTED rather than enforced (see `test.ts`). Wall-clock on this suite swings 24 %
 * on a byte-identical tree, memory swings with it, and a ratchet that fires on noise is deleted
 * within a week. Arming it is a follow-up that wants a few runs of data first.
 */
export const peakRegressed = (baselineMb: number, observedMb: number): boolean =>
  observedMb > baselineMb * 1.5 + 256
