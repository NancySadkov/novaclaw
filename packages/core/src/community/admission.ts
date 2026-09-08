export * as CommunityAdmission from "./admission"

/**
 * 🔴 **The governor in front of every anonymous peer route** — Codex review P1, 2026-08-17.
 *
 * The peer surface is open to strangers on purpose (that is the whole design: *"a node that only
 * accepts messages from callers holding this instance's token is a private federation with extra
 * steps"*), and what protects it is proof-of-work at the doors that STORE something. The doors that
 * merely READ have no such cost, and they amplify:
 *
 *   · `/sync/ids` returns ~335 KB for a ~200-byte request;
 *   · `GET /succession` served the whole table — ~230 KB for an ~80-byte GET, about 2,900×;
 *   · `/sync/summary` recomputes a 64-bucket digest over up to 5,000 ids on every call.
 *
 * The 256 KB inbound cap bounds one request's SIZE and says nothing about their number. So a
 * stranger with a loop turns a home machine into a bandwidth and CPU multiplier aimed at whoever
 * they like, and the design record already admitted it (`community-p2p.md:1319-1325`).
 *
 * ⚠️ **A token bucket, not proof-of-work, and the review is explicit about the order to try them
 * in**: work costs the HONEST caller ~49 ms per request on a surface whose whole point is that
 * catching up is cheap, while a bucket costs us one arithmetic step and costs an honest peer
 * nothing. Work belongs where a request makes us STORE something; rate belongs where it makes us
 * WORK. If measurement ever shows the bucket inadequate, that is the moment for a cost, not before.
 *
 * ⚠️ It must run BEFORE the database read, which is why it lives in the peer-door middleware rather
 * than in a handler: a limiter that fires after the amplification has been computed has bounded
 * nothing but the socket.
 */

/**
 * How many requests one source may make per window, and how many may be in flight at once.
 *
 * ⚠️ Generous on purpose. Several peers legitimately share one address — a household behind NAT, a
 * university, a VPN exit — and a catch-up is three requests per room per peer. The number that
 * matters is not "how few can a good peer live with" but "how few does a bad one need to be
 * pointless", and at this rate a single source can extract at most a few megabytes a minute from
 * the widest endpoint, against an unbounded firehose before.
 */
export const PER_SOURCE_PER_MINUTE = 120

/**
 * The whole instance's ceiling, across every source.
 *
 * 🔴 Per-source alone is not a bound: an attacker with a botnet, or simply a peer exchange that
 * hands out our address widely, arrives from many addresses at once. This is the number that keeps
 * a home machine's fan quiet, and it is what a user is actually consenting to when they join.
 */
export const GLOBAL_PER_MINUTE = 600

/** At most this many anonymous reads execute at once, whatever their rate. */
export const MAX_CONCURRENT = 8

const WINDOW_MS = 60_000

interface Bucket {
  /** Requests counted in the current window. */
  count: number
  /** When the current window began. */
  since: number
}

/**
 * ⚠️ Bounded, because the KEY is attacker-chosen. A map keyed on remote address with no cap is the
 * same disk-fill shape as the peer table one layer down: an attacker with a /64 of IPv6 mints a
 * fresh key per request. When it is full the oldest entries go, which costs those sources their
 * history and never costs us memory.
 */
const MAX_SOURCES = 4_096

export interface State {
  readonly sources: Map<string, Bucket>
  global: Bucket
  inFlight: number
}

export const make = (): State => ({ sources: new Map(), global: { count: 0, since: 0 }, inFlight: 0 })

const tick = (bucket: Bucket, now: number, limit: number): boolean => {
  if (now - bucket.since >= WINDOW_MS) {
    bucket.since = now
    bucket.count = 0
  }
  bucket.count += 1
  return bucket.count <= limit
}

/** Why a request was refused, so the caller can say which bound it hit. */
export type Refusal = "rate" | "busy"

/**
 * Admit one anonymous request, or say which ceiling it met.
 *
 * ⚠️ `now` is a parameter rather than a `Date.now()` call inside, so the windows can be exercised
 * without sleeping — a rate limiter tested by waiting is a rate limiter nobody runs.
 *
 * 🔴 **The SOURCE bucket is charged first, and a request it refuses never touches the global one.**
 * The reverse order — the one this function shipped with — turns the instance-wide ceiling into a
 * remote off switch: one address sends `GLOBAL_PER_MINUTE` requests, its own bucket refuses all but
 * the first `PER_SOURCE_PER_MINUTE`, and every one of those refusals has *already* spent a global
 * slot. The next well-behaved peer then meets a full global bucket and is refused before its own
 * bucket is even consulted. A ceiling that an over-limit request can spend is not a ceiling; the
 * per-source limit exists precisely so that one caller's excess is charged to that caller.
 */
export const admit = (state: State, source: string, now: number): Refusal | undefined => {
  if (state.inFlight >= MAX_CONCURRENT) return "busy"
  let bucket = state.sources.get(source)
  if (bucket === undefined) {
    if (state.sources.size >= MAX_SOURCES) {
      // Insertion order is eviction order: the oldest source loses its history, not its access.
      const oldest = state.sources.keys().next()
      if (!oldest.done) state.sources.delete(oldest.value)
    }
    bucket = { count: 0, since: now }
    state.sources.set(source, bucket)
  }
  if (!tick(bucket, now, PER_SOURCE_PER_MINUTE)) return "rate"
  if (!tick(state.global, now, GLOBAL_PER_MINUTE)) return "rate"
  state.inFlight += 1
  return undefined
}

/** Release a slot taken by `admit`. Must run whether the handler succeeded or failed. */
export const release = (state: State): void => {
  state.inFlight = Math.max(0, state.inFlight - 1)
}

/**
 * The process-wide governor.
 *
 * ⚠️ One per PROCESS, like the offline policy and the consent gate, and for the same reason: the
 * middleware has no service in scope, and a per-request instance would be a limiter that resets on
 * every request — which is a limiter that does nothing at all.
 */
let live: State | undefined

export const current = (): State => (live ??= make())

/** Tests only: forget the counters so one file's flood cannot refuse the next file's first request. */
export const reset = (): void => {
  live = undefined
}
