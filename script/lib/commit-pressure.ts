/**
 * How the gate talks about host commit charge while a unit runs.
 *
 * Pure and tested, because the interesting part is a JUDGEMENT rather than a measurement: which
 * readings deserve a line, and which are a unit's ordinary operating point. Getting that wrong is
 * not a crash, it is a warning nobody reads — a much quieter failure.
 */

/**
 * The default WARNING line. Deliberately the same number as `heavy-guard`'s admission line and the
 * product's own `Pressure` warning, so a breach in the gate reads the same as a breach in the app.
 */
export const HOST_COMMIT_WARN_PCT = 75

/**
 * The FLOOR — the product's own (`storage/pressure.ts` DEFAULT_THRESHOLDS), and product-wide rather
 * than per-unit. It has never been observed in 348 recorded unit-rows, which is what makes it usable:
 * a line for territory this machine has not entered.
 */
export const COMMIT_FLOOR_PCT = 90

export interface PressureLine {
  readonly level: "warning" | "FLOOR"
  readonly text: string
}

/**
 * Describe a unit's host-commit reading, or say nothing.
 *
 * 🔴 `warnAt` is PER UNIT, and that is a correction rather than a refinement. A flat 75% fired on
 * `core` in 15 of its 31 recorded runs — its median is 74% — while no other unit has ever reached 75
 * at all. A warning that fires on half of one unit's healthy runs is not a warning; it is a line the
 * reader learns to skip, including on the run where it means something.
 *
 * ⚠️ The FLOOR is checked independently of `warnAt`, and must be: raising a hot unit's warning line
 * says "this much is normal for you", never "you may quietly cross the floor".
 */
export function pressureLine(pct: number | undefined, warnAt: number): PressureLine | undefined {
  if (pct === undefined) return undefined
  if (pct >= COMMIT_FLOOR_PCT)
    return { level: "FLOOR", text: `host commit FLOOR — peaked ${pct}% while this unit ran` }
  if (pct < warnAt) return undefined
  // Naming the unit's own line matters: without it a reader sees "76%" beside another unit's "74%"
  // that said nothing, and concludes the gate is inconsistent rather than unit-aware.
  const note = warnAt === HOST_COMMIT_WARN_PCT ? "" : ` (this unit's line is ${warnAt}%, not ${HOST_COMMIT_WARN_PCT}%)`
  return { level: "warning", text: `host commit warning — peaked ${pct}% while this unit ran${note}` }
}
