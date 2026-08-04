import { pipe, groupBy, entries, map } from "remeda"

/**
 * The grouping decision behind `Select`, in its own module because a test that imports `select.tsx`
 * drags in Solid's web renderer and dies on `Export named 'use' not found`. Pure logic lives where it
 * can be exercised — the reason this shipped broken is that the decision was a JSX prop with no seam.
 *
 * ⚠️ With no `groupBy` this returns ONE section keyed `""`. That shape is harmless alone; what broke
 * the control was handing it to Kobalte *together with* `optionGroupChildren="options"`, which makes
 * Kobalte read every entry as a section rather than an option — so the list rendered EMPTY across the
 * Settings selectors, the model selectors and the thinking-level control.
 * Ported from https://github.com/NancySadkov/novaclaw/pull/12 by @DassaultFalconKing.
 */
export function selectGroups<T>(options: readonly T[], groupBy_?: (value: T) => string) {
  return pipe(
    options as T[],
    groupBy((x: T) => (groupBy_ ? groupBy_(x) : "")),
    entries(),
    map(([k, v]) => ({ category: k, options: v })),
  )
}

/** The ONE predicate `options` and `optionGroupChildren` are both derived from, so they cannot disagree. */
export const selectIsGrouped = <T>(groupBy_?: (value: T) => string): boolean => groupBy_ !== undefined
