export const OPEN_TAB_LIMIT = 4

function rank(keys: readonly string[]) {
  return new Map(keys.map((key, index) => [key, index] as const))
}

/** Keep the most recently opened tabs while preserving their stable visual order. */
export function retainRecentTabs<T>(
  tabs: readonly T[],
  recentKeys: readonly string[],
  keyOf: (tab: T) => string,
  limit = OPEN_TAB_LIMIT,
): T[] {
  if (tabs.length <= limit) return [...tabs]
  const ranks = rank(recentKeys)
  const keep = new Set(
    [...tabs]
      .sort((left, right) => {
        const leftRank = ranks.get(keyOf(left)) ?? Number.MAX_SAFE_INTEGER
        const rightRank = ranks.get(keyOf(right)) ?? Number.MAX_SAFE_INTEGER
        return leftRank === rightRank ? tabs.indexOf(right) - tabs.indexOf(left) : leftRank - rightRank
      })
      .slice(0, limit),
  )
  return tabs.filter((tab) => keep.has(tab))
}

/** Add a newly opened tab and evict the least recently used existing one when the strip is full. */
export function appendRecentTab<T>(
  tabs: readonly T[],
  next: T,
  recentKeys: readonly string[],
  keyOf: (tab: T) => string,
  limit = OPEN_TAB_LIMIT,
): { tabs: T[]; evicted: T[] } {
  const retained = retainRecentTabs(tabs, recentKeys, keyOf, Math.max(0, limit - 1))
  const keep = new Set(retained)
  const evicted = tabs.filter((tab) => !keep.has(tab))
  return {
    tabs: [...retained, next],
    evicted,
  }
}
