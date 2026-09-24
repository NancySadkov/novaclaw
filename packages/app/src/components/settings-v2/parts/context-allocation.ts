/**
 * The context-allocation arithmetic: five shares that must always total 100.
 *
 * 🔴 **Why the sum is an invariant of the MOVER, not of the store.** The Settings panel lets a
 * person drag the boundary between two neighbouring parts of the context window. A drag moves points
 * from one side to the other and can never change the total, so the only legal edit is a transfer
 * between adjacent shares. A control that wrote one share on its own could make the five sum to
 * something else, and the runner's profiles are percentages of the window — 105% is a promise no
 * window can keep. `moveBoundary` is the one place that transfer happens, and it clamps so neither
 * side can go below zero.
 *
 * ⚠️ Kept out of the `.tsx` so it is testable without a DOM, and so the component has no arithmetic
 * of its own to get wrong.
 */

/** The five parts, in the order they render left-to-right and in the order the kernel reads them. */
export const ALLOCATION_CATEGORIES = ["system", "messages", "retrieval", "memory", "tool_output"] as const
export type AllocationCategory = (typeof ALLOCATION_CATEGORIES)[number]

/** Officer and delegated worker layouts mirror `ContextBudget`'s profiles. */
export const ALLOCATION_PROFILES = ["officer", "sub-agent"] as const
export type AllocationProfile = (typeof ALLOCATION_PROFILES)[number]

/**
 * The shipped defaults, mirrored from `session/runner/context-budget.ts`.
 *
 * ⚠️ A MIRROR, and the app is a thin client that may talk to an older instance: an instance that has
 * never stored a profile answers with nothing, and this is what the panel shows it is running. The
 * two must not drift, so `context-allocation.test.ts` asserts this table against the profile the
 * instance actually resolves.
 */
export const DEFAULT_ALLOCATION: Readonly<Record<AllocationProfile, Readonly<Record<AllocationCategory, number>>>> = {
  officer: { system: 25, messages: 40, retrieval: 10, memory: 5, tool_output: 20 },
  "sub-agent": { system: 25, messages: 30, retrieval: 10, memory: 5, tool_output: 30 },
}

/** The stored profile, or the shipped default when the instance stored nothing. */
export const allocationShares = (
  profile: AllocationProfile,
  stored: Partial<Record<AllocationCategory, number>> | undefined,
): readonly number[] => ALLOCATION_CATEGORIES.map((category) => stored?.[category] ?? DEFAULT_ALLOCATION[profile][category])

/** Shares back to the record the config stores. The inverse of {@link allocationShares}. */
export const allocationRecord = (shares: readonly number[]): Record<AllocationCategory, number> =>
  Object.fromEntries(ALLOCATION_CATEGORIES.map((category, index) => [category, shares[index]!])) as Record<
    AllocationCategory,
    number
  >

/**
 * Move the boundary between `shares[boundary]` and `shares[boundary + 1]` by `delta` points.
 *
 * Positive `delta` grows the LEFT share (drag right); negative grows the right. The transfer is
 * clamped so neither side goes below zero and the total is preserved exactly. An out-of-range
 * boundary is returned untouched rather than throwing: the caller is a drag handler, and a control
 * must not be able to cost the panel.
 */
export const moveBoundary = (shares: readonly number[], boundary: number, delta: number): readonly number[] => {
  const left = shares[boundary]
  const right = shares[boundary + 1]
  if (left === undefined || right === undefined) return shares
  const moved = Math.max(-left, Math.min(right, Math.round(delta)))
  const next = [...shares]
  next[boundary] = left + moved
  next[boundary + 1] = right - moved
  return next
}
