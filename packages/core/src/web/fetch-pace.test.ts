// The web traffic governor's pure policy. Pins the properties that keep our reads looking like a person
// reading articles: a small burst then a slow settle, jittered waits, a per-host daily ceiling, a UTC
// rollover, and a loop refusal. All deterministic — `now` and `random` are injected.
import { describe, expect, test } from "bun:test"
import { WebFetchPace } from "@novaclaw/core/web/fetch-pace"

const T0 = Date.UTC(2026, 6, 25, 12, 0, 0)
const limits = { intervalMs: 4_000, burst: 3, dailyLimit: 5 }

/** Walk n sequential decisions, threading state + honouring each returned wait. */
const walk = (n: number, start = T0, opts = limits) => {
  let state: WebFetchPace.HostState | undefined
  let now = start
  const out: Array<{ waitMs: number; at: number }> = []
  for (let i = 0; i < n; i++) {
    const d = WebFetchPace.decide(state, now, opts)
    if (d.kind === "deny") return { out, denied: d.reason }
    out.push({ waitMs: d.waitMs, at: now })
    state = d.state
    now += d.waitMs // the caller sleeps, then fetches
  }
  return { out, denied: undefined, state }
}

describe("hostOf", () => {
  test("lowercases and folds www so one site can't get double budget", () => {
    expect(WebFetchPace.hostOf("https://WWW.Example.COM/a/b?c=1")).toBe("example.com")
    expect(WebFetchPace.hostOf("https://example.com/x")).toBe("example.com")
    // a genuinely different subdomain keeps its own budget
    expect(WebFetchPace.hostOf("https://news.example.com/x")).toBe("news.example.com")
  })
})

describe("dayOf", () => {
  test("is a UTC day key", () => {
    expect(WebFetchPace.dayOf(Date.UTC(2026, 6, 25, 23, 59))).toBe("2026-07-25")
    expect(WebFetchPace.dayOf(Date.UTC(2026, 6, 26, 0, 1))).toBe("2026-07-26")
  })
})

describe("decide — burst then settle", () => {
  test("the burst goes immediately, then every further read waits the interval", () => {
    const { out } = walk(6)
    // first 3 (burst) are free
    expect(out.slice(0, 3).map((x) => x.waitMs)).toEqual([0, 0, 0])
    // then it settles to ~one per interval
    expect(out.slice(3).every((x) => x.waitMs > 0)).toBe(true)
    expect(out[3]!.waitMs).toBe(4_000)
  })

  test("waiting long enough refills the bucket back to a full burst", () => {
    const first = WebFetchPace.decide(undefined, T0, limits)
    expect(first.kind).toBe("go")
    const state = first.kind === "go" ? first.state : undefined
    // idle for 10 intervals — refill is capped at burst, not unbounded
    const later = WebFetchPace.decide(state, T0 + 10 * 4_000, limits)
    expect(later.kind).toBe("go")
    if (later.kind === "go") {
      expect(later.waitMs).toBe(0)
      expect(later.state.tokens).toBeLessThanOrEqual(limits.burst)
    }
  })

  test("a fresh host is never made to wait", () => {
    const d = WebFetchPace.decide(undefined, T0, limits)
    expect(d.kind === "go" && d.waitMs).toBe(0)
  })
})

describe("decide — daily cap", () => {
  test("denies past the per-host daily limit, with a legible reason", () => {
    const r = walk(limits.dailyLimit + 1)
    expect(r.denied).toBeDefined()
    expect(r.denied).toContain("Daily read limit reached")
    expect(r.out).toHaveLength(limits.dailyLimit) // exactly the cap got through
  })

  test("pacing itself never denies — it only waits", () => {
    // Well under the daily cap, but far past the burst: every decision is still `go`.
    const r = walk(4, T0, { ...limits, dailyLimit: 1000 })
    expect(r.denied).toBeUndefined()
  })

  test("a new UTC day resets the count and restores the burst", () => {
    const spent = walk(limits.dailyLimit, T0)
    expect(spent.denied).toBeUndefined()
    const nextDay = WebFetchPace.decide(spent.state, T0 + 24 * 3_600_000, limits)
    expect(nextDay.kind).toBe("go")
    if (nextDay.kind === "go") {
      expect(nextDay.waitMs).toBe(0)
      expect(nextDay.state.count).toBe(1) // counter rolled over, not carried
      expect(nextDay.state.day).toBe("2026-07-26")
    }
  })
})

describe("decide — concurrency safety", () => {
  test("charges the wait forward so two deciders can't both fetch 'now'", () => {
    // Spend the burst, then take two decisions at the SAME instant.
    const spent = walk(3)
    const a = WebFetchPace.decide(spent.state, T0, limits)
    expect(a.kind).toBe("go")
    const b = a.kind === "go" ? WebFetchPace.decide(a.state, T0, limits) : undefined
    expect(b?.kind).toBe("go")
    // The second must wait strictly longer — the first already claimed its slot.
    if (a.kind === "go" && b?.kind === "go") expect(b.waitMs).toBeGreaterThan(a.waitMs)
  })
})

describe("the 0-means-unset sentinel", () => {
  // Config writes are a MERGE patch, so an emptied settings field cannot delete its key — it is stored
  // as 0. If 0 were taken literally, clearing "reads per site per day" would set the cap to ZERO and deny
  // every fetch (and clearing the interval would mean a zero-delay hammer). Verified live: blanking a
  // field left the old value in config, which is what forced this convention.
  test("0 falls back to the default rather than denying everything", () => {
    const d = WebFetchPace.decide(undefined, T0, { intervalMs: 0, burst: 0, dailyLimit: 0 })
    expect(d.kind).toBe("go")
    if (d.kind === "go") expect(d.waitMs).toBe(0)
  })

  test("a cleared daily cap behaves exactly like an unset one", () => {
    const cleared = WebFetchPace.decide(undefined, T0, { dailyLimit: 0 })
    const unset = WebFetchPace.decide(undefined, T0, {})
    expect(cleared).toEqual(unset)
  })

  test("a real positive override is still honoured", () => {
    const r = walk(3, T0, { ...limits, dailyLimit: 2 })
    expect(r.denied).toContain("Daily read limit reached")
    expect(r.out).toHaveLength(2)
  })
})

describe("jitter", () => {
  test("stays within the fraction and never goes negative", () => {
    for (const r of [0, 0.5, 1]) {
      const j = WebFetchPace.jitter(1_000, () => r, 0.4)
      expect(j).toBeGreaterThanOrEqual(600)
      expect(j).toBeLessThanOrEqual(1_400)
    }
  })

  test("a zero wait stays zero (no artificial delay on a free burst slot)", () => {
    expect(WebFetchPace.jitter(0, () => 0.9)).toBe(0)
  })

  test("is not a metronome — different randoms give different waits", () => {
    expect(WebFetchPace.jitter(1_000, () => 0.1)).not.toBe(WebFetchPace.jitter(1_000, () => 0.9))
  })
})

describe("loop guard", () => {
  test("trips at the limit and explains itself without blaming the site", () => {
    expect(WebFetchPace.isLoop(2)).toBe(false)
    expect(WebFetchPace.isLoop(3)).toBe(true)
    const reason = WebFetchPace.loopReason("https://example.com/a", 3)
    expect(reason).toContain("fetch loop")
    expect(reason).toContain("DIFFERENT source")
  })
})
