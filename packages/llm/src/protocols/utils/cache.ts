// Provider cache-marker lowering. Anthropic enforces a 4-breakpoint cap per
// request and accepts `5m`/`1h` TTL buckets; the counter and the TTL mapping
// live here rather than inline so the cap is spent in one place.
// ⚠️ `anthropic-messages.ts` is the only consumer today. Kept separate because a
// second cache-marker wire would otherwise copy the cap arithmetic, which is
// the shape that goes wrong silently — an over-spent breakpoint is not an error,
// it is a cache miss nobody sees.

export interface Breakpoints {
  remaining: number
  dropped: number
}

export const newBreakpoints = (cap: number): Breakpoints => ({ remaining: cap, dropped: 0 })

// Returns `"1h"` for any `ttlSeconds >= 3600`, otherwise `undefined` (the
// provider default 5m). Anthropic treats anything shorter than an hour as 5m.
export const ttlBucket = (ttlSeconds: number | undefined): "1h" | undefined =>
  ttlSeconds !== undefined && ttlSeconds >= 3600 ? "1h" : undefined
