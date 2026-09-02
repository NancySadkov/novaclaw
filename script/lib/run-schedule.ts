/**
 * WHICH unit runs next, and whether another one may start beside it.
 *
 * ─── why this exists ────────────────────────────────────────────────────────────────────────────
 *
 * 🔴 **The gate was 100% serial on a 20-core box, and that was the single biggest cost in it.**
 * Measured 2026-09-02: a `--full` run took **1142 s** wall while its unit times summed to **1080 s**.
 * Sum ≈ wall is what serial execution looks like; the 62 s remainder is the runner's own overhead.
 * `script/test.ts` drove every child with `spawnSync` and iterated `for (const pkg of PACKAGES)`, so
 * nineteen idle cores watched one `bun` at a time. Sharding did not help either — shards were built
 * with `.map(spawnWithUpstreamRetry)` and therefore also ran one after another, which is why `core`
 * sharded ×2 measured 446–465 s, indistinguishable from unsharded.
 *
 * ⚠️ **This is NOT "add `Promise.all`", and the reason is written in blood elsewhere in this
 * directory.** Host commit peaked 88–99 % during those very runs, and on this hardware a thrash is
 * not an OOM: it takes the machine down without an OOM killer ever firing (2026-07-20). So the
 * question a scheduler has to answer is not *how many cores are there* but *how much memory has
 * already been promised*, and the harness already owns that instrument — `memory-plan.ts`.
 *
 * ─── the two decisions, and why each is shaped this way ─────────────────────────────────────────
 *
 * **1. Admission is against a RESERVED budget, never against live headroom.** A unit that started
 * 200 ms ago has not grown into its peak yet, so a live reading taken beside it reports memory that
 * is already spoken for. {@link admits} therefore measures the machine once while the pool is EMPTY
 * and hands out {@link Reservation}s from that figure — a unit holds its full
 * `MemoryPlan.requiredBytes` for its whole life, and the sum may never exceed the budget. That is
 * deliberately conservative in one direction only: it under-admits when units are lighter than
 * their profile, and it cannot over-admit when they are heavier.
 *
 * ⚠️ At a concurrency of 1 the arithmetic is *identical to the old behaviour* — the pool is empty
 * before every unit, so the budget is a live reading and the reservation is the plan. That is what
 * makes `NOVACLAW_TEST_CONCURRENCY=1` an honest A/B arm rather than a different code path.
 *
 * **2. Order is LONGEST-FIRST, from measured history rather than a hand-kept hint.** With a pool,
 * makespan is bounded below by the longest single unit, so a long unit that starts late adds its
 * whole length to the wall clock. Measured over `tmp/peak-series.jsonl` (9 606 rows): `core` has a
 * median of 277 s and `novaclaw test/*` 307 s, while sixteen units sit under 6 s. Starting those two
 * last would cost ~300 s of pure tail. A hand-maintained duration column would go stale silently
 * (the same defect `run-units.ts` records for its package list), so the order is DERIVED from the
 * series the gate already writes, and `test.ts` prints it — an order that varies with history has to
 * be legible, or a load-dependent flake becomes unreproducible.
 *
 * ⚠️ **A unit with no history sorts LAST, not first.** An unmeasured unit is usually a new one, and
 * a new unit is far more often small than it is another `core`. Sorting it first on the chance that
 * it is large would pay the tail cost every time to hedge against the rare case.
 */

/** A unit's claim on the pool's budget, in bytes, for as long as it runs. */
export interface Reservation {
  readonly unit: string
  readonly commitBytes: number
  readonly residentBytes: number
  /**
   * Both of this unit's demands come from a MEASUREMENT, not from `UNPROFILED_*_MB`.
   *
   * 🔴 **An unprofiled unit runs SOLO, and this is the arm that makes the budget mean anything.**
   * `memory-plan.ts` calls its defaults *"a declared guess"*, and a guess is fine for the question
   * they were written for — *does this one unit fit on this machine* — because being wrong there
   * costs a needless shard. It is not fine as a line in a ledger of who has promised what. Measured
   * 2026-09-02: every `novaclaw test/*` sub-unit is absent from `peaks`, and several of them really
   * cost 3–9 GB; admitting three at 1 200 MB apiece would promise 3.6 GB against ~20 GB of actual
   * demand, which is the 2026-07-20 thrash with a spreadsheet in front of it.
   *
   * ⚠️ It cuts BOTH ways — an unprofiled unit is neither admitted beside a neighbour nor joined by
   * one — because the hazard is the pair, not the newcomer. And it is self-correcting rather than a
   * permanent exclusion: a unit joins the pool the run after its profile is measured, which is the
   * same incentive `peaksUnsampledNote` already relies on.
   */
  readonly profiled: boolean
}

/** The two independent walls, measured while the pool was empty. Never collapsed through `min()`. */
export interface Budget {
  readonly commitBytes: number
  readonly residentBytes: number
}

export type Admission = { readonly admit: true } | { readonly admit: false; readonly reason: string }

/**
 * The measured headroom, less the harness's own fixed slack, charged ONCE.
 *
 * See `MemoryPlan.reservedBytes` for why this is not the same as summing `requiredBytes`: the slack
 * is the runner's cost, and a pool does not acquire a second runner by admitting a second unit.
 */
export const poolBudget = (headroom: Budget, slackBytes: number): Budget => ({
  commitBytes: Math.max(0, headroom.commitBytes - slackBytes),
  residentBytes: Math.max(0, headroom.residentBytes - slackBytes),
})

/**
 * The hard ceiling on units in flight, whatever the memory says.
 *
 * ⚠️ **Deliberately conservative, and it is a starting point rather than a measurement.** The memory
 * budget is the arm that actually binds on this box — `core` alone reserves ~14.6 GB of a ~23 GB
 * idle budget — so this cap exists for the opposite shape: the sixteen units that finish in under
 * six seconds, where nothing stops the budget admitting all of them at once and the only thing being
 * multiplied is process start-up against one disk. Four changes one variable at a time; raise it
 * once a run has been measured at four, not before.
 */
export const DEFAULT_MAX_CONCURRENCY = 4

/** How many cores to leave for the runner, its sampler, and the machine's owner. */
const RESERVED_CORES = 2

/**
 * The concurrency cap for this invocation.
 *
 * `NOVACLAW_TEST_CONCURRENCY` is not a convenience: a change that claims to make the gate faster has
 * to be provable by running the SAME code with the pool disabled, and `=1` is that arm (AGENTS.md →
 * binary dissection: every step is the same measurement under the same conditions).
 */
export function concurrencyCap(cpus: number, forced?: string | undefined): number {
  const parsed = Number(forced)
  if (Number.isFinite(parsed) && parsed >= 1) return Math.floor(parsed)
  const usable = Number.isFinite(cpus) ? Math.floor(cpus) - RESERVED_CORES : 0
  return Math.max(1, Math.min(DEFAULT_MAX_CONCURRENCY, usable))
}

/**
 * May one more unit start right now?
 *
 * An EMPTY pool always admits: refusing there would leave the gate unable to run a unit the machine
 * genuinely cannot fit, which is `MemoryPlan.planFor`'s decision to make (it can shard, and it can
 * refuse with a message naming what still fits). This function only ever answers *"is there room
 * BESIDE what is already running"*.
 */
export function admits(
  budget: Budget,
  inFlight: readonly Reservation[],
  candidate: Reservation,
  cap: number,
): Admission {
  if (inFlight.length === 0) return { admit: true }
  if (inFlight.length >= cap) return { admit: false, reason: `at the concurrency cap of ${cap}` }
  // Before any arithmetic, because the arithmetic is what is missing. See `Reservation.profiled`.
  if (!candidate.profiled)
    return { admit: false, reason: `${candidate.unit} has no measured memory profile, so it runs alone` }
  const unprofiled = inFlight.find((r) => !r.profiled)
  if (unprofiled)
    return { admit: false, reason: `${unprofiled.unit} has no measured memory profile and is running alone` }
  const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`
  const heldCommit = inFlight.reduce((a, r) => a + r.commitBytes, 0)
  const heldResident = inFlight.reduce((a, r) => a + r.residentBytes, 0)
  if (heldCommit + candidate.commitBytes > budget.commitBytes)
    return {
      admit: false,
      reason:
        `commit budget: ${inFlight.length} unit(s) hold ${gb(heldCommit)} of ${gb(budget.commitBytes)}, ` +
        `and ${candidate.unit} needs ${gb(candidate.commitBytes)}`,
    }
  if (heldResident + candidate.residentBytes > budget.residentBytes)
    return {
      admit: false,
      reason:
        `resident budget: ${inFlight.length} unit(s) hold ${gb(heldResident)} of ${gb(budget.residentBytes)}, ` +
        `and ${candidate.unit} needs ${gb(candidate.residentBytes)}`,
    }
  return { admit: true }
}

/**
 * Median observed duration per unit, from the peak series this gate already writes.
 *
 * ⚠️ Median rather than max: the suite's wall clock swings ~24 % on a byte-identical tree, so the
 * maximum is a reading of the worst neighbour a unit ever had. Ordering wants the typical cost.
 *
 * ⚠️ Only `ok` test rows count. A unit that was wall-clock-killed contributes its BACKSTOP (600 s
 * for `core`, 900 s for `novaclaw test/*`) rather than its cost, and a handful of those would pin a
 * unit to the front of the queue on the strength of the times it failed.
 *
 * A malformed line is skipped rather than thrown on: this is an ordering hint read from a
 * gitignored log, and an unreadable log must degrade to "no history", never take the gate down.
 */
export function observedCosts(seriesText: string): Map<string, number> {
  const samples = new Map<string, number[]>()
  for (const line of seriesText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let row: { unit?: unknown; kind?: unknown; ok?: unknown; ms?: unknown }
    try {
      row = JSON.parse(trimmed) as typeof row
    } catch {
      continue
    }
    if (row.kind !== "test" || row.ok !== true) continue
    if (typeof row.unit !== "string" || typeof row.ms !== "number" || !Number.isFinite(row.ms)) continue
    const bucket = samples.get(row.unit)
    if (bucket) bucket.push(row.ms)
    else samples.set(row.unit, [row.ms])
  }
  const costs = new Map<string, number>()
  for (const [unit, values] of samples) {
    values.sort((a, b) => a - b)
    costs.set(unit, values[Math.floor(values.length / 2)] ?? 0)
  }
  return costs
}

/**
 * Longest-first, with everything unmeasured keeping its declared order at the back.
 *
 * Stable by construction — ties and unknowns fall back to the index in `units`, so the same series
 * and the same table always produce the same order. A scheduler whose order wobbles between runs on
 * identical inputs would make a load-dependent red impossible to reproduce.
 */
export function orderByCost<T>(
  units: readonly T[],
  nameOf: (unit: T) => string,
  costs: ReadonlyMap<string, number>,
): T[] {
  return units
    .map((unit, index) => ({ unit, index, cost: costs.get(nameOf(unit)) }))
    .sort((a, b) => {
      if (a.cost === undefined && b.cost === undefined) return a.index - b.index
      if (a.cost === undefined) return 1
      if (b.cost === undefined) return -1
      return b.cost - a.cost || a.index - b.index
    })
    .map((entry) => entry.unit)
}
