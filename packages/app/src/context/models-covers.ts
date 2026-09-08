/**
 * Which "removed" covers still deserve to hide something — the rule above, as a pure function.
 *
 * Returns `undefined` when nothing changes, so the caller writes only on a real difference: an
 * effect that writes its own dependency every run is a loop, and "no write" is the common case.
 */
export const pruneCovers = (input: {
  readonly removed: readonly string[]
  readonly listed: readonly string[]
}): string[] | undefined => {
  // Boot guard: an empty catalog means providers have not loaded, not that every model is gone.
  if (input.listed.length === 0) return undefined
  const listed = new Set(input.listed)
  const kept = input.removed.filter((key) => listed.has(key))
  return kept.length === input.removed.length ? undefined : kept
}
