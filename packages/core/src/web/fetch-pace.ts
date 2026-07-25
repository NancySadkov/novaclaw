export * as WebFetchPace from "./fetch-pace"

// The web traffic governor (owner call 2026-07-25). Sibling of the messenger's pacing governor
// (AGENTS.md Design-principle #9) applied to OUTBOUND WEB READS.
//
// Stance: NovaClaw reads ARTICLES for a private individual, at that person's request, from that
// person's own machine and IP — it does not mirror sites and is not a search-index crawler. So
// `robots.txt` (a 1994 convention aimed at recursive indexers) is treated as INFORMATIONAL, not
// binding, for the reads we do.
//
// That stance only holds if our traffic actually looks like a person reading. The real hazard is not
// policy, it is an agent stuck in a fetch loop hammering one host until the USER'S ip is banned — a
// self-inflicted outage for a local-first product, and exactly the failure the doom-loop guard exists
// for elsewhere. Hence this module, and hence it lives in core rather than in each agent's adapter:
//
//   1. **Human pacing, not metronome pacing.** A token bucket per host allows a small burst (people do
//      open a few tabs) then settles to a slow rate. Delays are JITTERED — a fixed interval is itself a
//      bot signature.
//   2. **A per-host DAILY cap.** What a heavy human reader might plausibly get through on one site.
//   3. **One request in flight per host.** No swarming a site with parallel streams.
//   4. **Loop detection.** Re-fetching the same URL over and over is a runaway, not research; refuse it
//      with a legible reason instead of grinding.
//
// Everything here is pure and takes `now` as an argument (no `Date.now()`), so the policy is unit-tested
// without a clock. The effectful service + durable per-host counters live in `fetch-governor.ts`.

/** Sustained pace: one fetch per host per this interval, once any burst is spent. */
export const HOST_INTERVAL_MS = 4_000
/** Burst capacity — a person opening a handful of tabs at once. */
export const HOST_BURST = 3
/** Per-host reads per UTC day. A heavy human reader; orders of magnitude below mirroring a site. */
export const HOST_DAILY_LIMIT = 150
/** Jitter applied to every computed wait, ±this fraction — a metronome is a bot tell. */
export const JITTER_FRACTION = 0.4
/** Fetching one URL more than this many times in a session is a loop, not research. */
export const SAME_URL_LIMIT = 3

/** Per-host token-bucket + counter state. Serialized into the durable store between runs. */
export interface HostState {
  /** UTC day (YYYY-MM-DD) the count belongs to; a different day resets it. */
  readonly day: string
  readonly count: number
  /** Fractional tokens available, as of `updatedAt`. */
  readonly tokens: number
  readonly updatedAt: number
}

export type Decision =
  | { readonly kind: "go"; readonly waitMs: number; readonly state: HostState }
  | { readonly kind: "deny"; readonly reason: string }

export interface Limits {
  readonly intervalMs?: number
  readonly burst?: number
  readonly dailyLimit?: number
}

/**
 * A configured limit, or `undefined` to mean "use the default".
 *
 * ⚠️ **`0` means unset, not zero.** The settings surface persists through a MERGE patch, which cannot
 * delete a key — so an emptied field is stored as `0` rather than disappearing (the same convention the
 * rest of the config uses: write `""`/`0` for "use default"). Treating any non-positive value as unset is
 * what makes "clear the field → back to the default" actually work. It also means an interval of 0 is
 * unreachable by accident, which is a feature: no one sets a zero-delay hammer by fat-fingering a box.
 */
const positive = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined

/** UTC day key. Takes `now` so it stays pure. */
export const dayOf = (now: number): string => new Date(now).toISOString().slice(0, 10)

/** Host of a URL, lowercased, `www.` folded so a site can't get 2x budget via a subdomain alias. */
export const hostOf = (url: string): string => {
  const host = new URL(url).hostname.toLowerCase().replace(/\.$/, "")
  return host.startsWith("www.") ? host.slice(4) : host
}

export const initialState = (now: number, limits?: Limits): HostState => ({
  day: dayOf(now),
  count: 0,
  // Must resolve the sentinel the SAME way `decide` does — a cleared (0) burst here meant a fresh host
  // started with zero tokens and waited a full interval for its very first read.
  tokens: positive(limits?.burst) ?? HOST_BURST,
  updatedAt: now,
})

/**
 * Decide whether a fetch to this host may proceed, how long to wait first, and the state to persist.
 *
 * Refills the bucket for elapsed time, rolls the daily counter over at UTC midnight, and returns the
 * wait needed for a token to exist. `deny` is only for the daily cap — pacing never denies, it waits.
 */
export const decide = (state: HostState | undefined, now: number, limits?: Limits): Decision => {
  const intervalMs = positive(limits?.intervalMs) ?? HOST_INTERVAL_MS
  const burst = positive(limits?.burst) ?? HOST_BURST
  const dailyLimit = positive(limits?.dailyLimit) ?? HOST_DAILY_LIMIT
  const today = dayOf(now)
  const current = state ?? initialState(now, limits)
  // A new UTC day resets the count AND hands back a full burst.
  const rolled: HostState =
    current.day === today ? current : { day: today, count: 0, tokens: burst, updatedAt: now }

  if (rolled.count >= dailyLimit)
    return {
      kind: "deny",
      reason:
        `Daily read limit reached for this site (${rolled.count}/${dailyLimit} today). This cap keeps our ` +
        `traffic in the range of a person reading, so the user's IP is never banned for a runaway agent. ` +
        `Use what you already fetched, cite a different source, or resume tomorrow.`,
    }

  // `updatedAt` may sit in the FUTURE, because each decision charges its slot forward (below). Measure
  // from that instant, not from `now`, or two deciders racing at the same `now` both compute the same
  // wait and collide on one slot — the swarm this module exists to prevent.
  const base = Math.max(now, rolled.updatedAt)
  const elapsed = base - rolled.updatedAt
  // Refill: one token per interval of elapsed time, capped at burst.
  const tokens = Math.min(burst, rolled.tokens + elapsed / intervalMs)
  // A whole token must exist to go; otherwise wait for the shortfall to accrue.
  const shortfallMs = tokens >= 1 ? 0 : Math.ceil((1 - tokens) * intervalMs)
  const fireAt = base + shortfallMs
  return {
    kind: "go",
    waitMs: Math.max(0, fireAt - now),
    state: {
      day: today,
      count: rolled.count + 1,
      tokens: Math.max(0, (tokens >= 1 ? tokens : 1) - 1),
      // Claim this slot so the next decider queues BEHIND it rather than beside it.
      updatedAt: fireAt,
    },
  }
}

/** Jitter a wait so our cadence isn't machine-regular. `random` injected for determinism in tests. */
export const jitter = (ms: number, random: () => number, fraction = JITTER_FRACTION): number => {
  if (ms <= 0) return 0
  const factor = 1 + (random() * 2 - 1) * fraction
  return Math.max(0, Math.round(ms * factor))
}

/** A runaway check independent of pacing: the same URL fetched over and over is a stuck agent. */
export const isLoop = (seenCount: number, limit = SAME_URL_LIMIT): boolean => seenCount >= limit

export const loopReason = (url: string, seenCount: number): string =>
  `Refusing to fetch ${url} again — it has already been fetched ${seenCount} times in this session, ` +
  `which is a fetch loop rather than research. The earlier result is already in the transcript; re-read ` +
  `that instead, or fetch a DIFFERENT source.`
