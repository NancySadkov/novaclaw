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
 * Measured 2026-08-05 (notes/test-harness-memory.md), sampling commit charge across the whole `bun`
 * tree every 200 ms: **`core`, the heaviest fast-tier unit, peaks at ~1.0 GB run whole.** The floor
 * was six times the measured need, and on a 15.7 GB desktop with a browser open the gate was
 * unrunnable for an entire working day.
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
 */

/** A unit's recorded peak, in MB of commit charge (Windows) or RSS (elsewhere). */
export type PeakProfile = Readonly<Record<string, number>>

const MB = 1024 ** 2

/**
 * Headroom a unit needs beyond its own peak before it may run whole.
 *
 * 1.3× is the working figure: `core` peaked at ~1.0 GB across five measurements that varied by under
 * 3 %, so the variance being covered is small, and the slack below carries the fixed cost (the
 * runner itself, bun's own startup) that scales with nothing.
 */
export const WHOLE_HEADROOM_FACTOR = 1.3

/** Fixed slack added to every requirement: the runner process, and room to not be at exactly zero. */
export const SLACK_BYTES = 512 * MB

/**
 * The floor below which nothing runs, sharded or not.
 *
 * Measured: one shard of `core` (~40 files) peaked at 1 007 MB, and the smallest observed unit peak
 * is ~780 MB — peak is dominated by a per-process baseline (module graph, Effect runtime, sqlite)
 * and is nearly FLAT in file count, which is precisely why sharding buys so little peak and why this
 * floor cannot be lowered by splitting harder.
 */
export const MIN_VIABLE_BYTES = 1200 * MB

/** What a unit is assumed to need when nothing has measured it yet. Deliberately generous. */
export const UNPROFILED_PEAK_MB = 1200

/** Never split a unit into more shards than this — past it, per-process startup dominates. */
export const MAX_SHARDS = 8

export type Plan =
  | { readonly mode: "whole"; readonly requiredBytes: number }
  /**
   * ⚠️ **A WEAKER RESULT, and it must be reported as one.** Splitting a unit changes which files
   * share a process, and that changes behaviour: measured 2026-08-05, eight green batches over
   * `core` concealed a wedge that only exists when the unit runs whole, and `--shard=1/2` wedged
   * where the whole unit did not. A sharded pass is most of the signal, not the gate.
   */
  | { readonly mode: "sharded"; readonly shards: number; readonly requiredBytes: number }
  | { readonly mode: "refuse"; readonly requiredBytes: number }

/** Bytes a unit with this peak needs free to run whole. */
export const requiredBytes = (peakMb: number): number => Math.round(peakMb * MB * WHOLE_HEADROOM_FACTOR) + SLACK_BYTES

/**
 * Pick the rung.
 *
 * `headroomBytes` is the SMALLER of free RAM and commit headroom — a machine can have free RAM and
 * no commit left, and on Windows commit-vs-limit is the pair that predicts the crash (AGENTS.md →
 * Known pitfalls #8).
 */
export function planFor(peakMb: number, headroomBytes: number): Plan {
  const required = requiredBytes(peakMb)
  if (!Number.isFinite(headroomBytes)) return { mode: "whole", requiredBytes: required }
  if (headroomBytes >= required) return { mode: "whole", requiredBytes: required }
  if (headroomBytes < MIN_VIABLE_BYTES) return { mode: "refuse", requiredBytes: required }
  // Peak is nearly flat in file count, so shards do not divide the requirement — the split buys the
  // GC and fixture churn of a shorter-lived process, not a proportionally smaller heap. Scale gently
  // and cap: a shard count derived as `required/headroom` would promise a reduction we measured is
  // not there.
  const shards = Math.min(MAX_SHARDS, Math.max(2, Math.ceil(required / headroomBytes)))
  return { mode: "sharded", shards, requiredBytes: required }
}

/** The peak to plan with: what was measured for this unit, or the generous default. */
export const peakFor = (profile: PeakProfile, unit: string): number => profile[unit] ?? UNPROFILED_PEAK_MB

/**
 * Units that would fit in the headroom we have — the actionable half of a refusal.
 *
 * A refusal that names only what is missing tells the user nothing they can do right now. This turns
 * it into "these still fit", which is a working command rather than a wait.
 */
export function unitsThatFit(profile: PeakProfile, units: readonly string[], headroomBytes: number): string[] {
  return units.filter((unit) => planFor(peakFor(profile, unit), headroomBytes).mode === "whole")
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
