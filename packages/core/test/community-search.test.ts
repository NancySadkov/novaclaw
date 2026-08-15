import { describe, expect, test } from "bun:test"
import { CommunitySearch } from "@novaclaw/core/community/search"

/**
 * Community P5 — throttled broadcast search (`todo/community-p2p.md`).
 *
 * 🔴 These are the three controls whose absence collapsed Gnutella in 2001. Each test below is a way
 * the network eats itself, so each removal has been checked to make the corresponding test fail.
 */

const query = (over: Partial<CommunitySearch.Query> = {}): CommunitySearch.Query => ({
  id: "q1",
  terms: "gguf 7b",
  ttl: CommunitySearch.DEFAULT_TTL,
  origin: "nid_asker",
  ...over,
})

const context = (over: { now?: number; self?: string } = {}) => ({
  self: over.self ?? "nid_me",
  seen: new CommunitySearch.Seen(),
  throttle: new CommunitySearch.Throttle(),
  now: over.now ?? 1_700_000_000_000,
})

describe("CommunitySearch.consider", () => {
  test("forwards a fresh query with one hop spent", () => {
    const verdict = CommunitySearch.consider(query(), context())
    expect(verdict.forward).toBe(true)
    if (verdict.forward) expect(verdict.next.ttl).toBe(CommunitySearch.DEFAULT_TTL - 1)
  })

  test("🔴 THE cycle killer: the same id arriving twice is refused", () => {
    const ctx = context()
    // Every real peer graph has cycles. Without this, one query returns to a node by another path,
    // is forwarded again, and the traffic grows with users × hops until the slowest links die —
    // which is precisely what happened to Gnutella.
    expect(CommunitySearch.consider(query(), ctx).forward).toBe(true)
    expect(CommunitySearch.consider(query(), ctx)).toEqual({ forward: false, reason: "duplicate" })
  })

  test("🔴 a refused query is still REMEMBERED, or the refusal is per-neighbour", () => {
    const ctx = context()
    // Expired on arrival, so it is not forwarded — but the id must still be recorded, otherwise the
    // same id from the next neighbour is treated as new and re-evaluated by every node it touches.
    expect(CommunitySearch.consider(query({ ttl: 1 }), ctx)).toEqual({ forward: false, reason: "expired" })
    expect(CommunitySearch.consider(query({ ttl: 4 }), ctx)).toEqual({ forward: false, reason: "duplicate" })
  })

  test("🔴 TTL bounds the blast radius even when nothing is duplicated", () => {
    // A hop chain with all-distinct ids: dedup cannot help, so only TTL stops it.
    let hops = 0
    let current = query({ ttl: 3 })
    for (let i = 0; i < 10; i++) {
      const verdict = CommunitySearch.consider(current, context({ self: `nid_hop${i}` }))
      if (!verdict.forward) break
      hops++
      current = { ...verdict.next, id: `q-${i}` }
    }
    expect(hops).toBe(2)
  })

  test("🔴 the throttle is keyed on ORIGIN, not on the sender", () => {
    const ctx = context()
    // A flooder relaying its own queries through different neighbours would get a fresh budget per
    // neighbour if this were keyed on whoever handed it over. Distinct ids, one origin.
    const verdicts = Array.from({ length: 14 }, (_, i) =>
      CommunitySearch.consider(query({ id: `flood-${i}` }), ctx),
    )
    expect(verdicts.filter((v) => v.forward)).toHaveLength(10)
    expect(verdicts.filter((v) => !v.forward && v.reason === "throttled")).toHaveLength(4)
  })

  test("we never relay our OWN query back into the network", () => {
    const verdict = CommunitySearch.consider(query({ origin: "nid_me" }), context({ self: "nid_me" }))
    expect(verdict).toEqual({ forward: false, reason: "own-query" })
  })
})

describe("CommunitySearch.Seen", () => {
  test("🔴 forgets after the window — a permanent set is a free memory attack", () => {
    const seen = new CommunitySearch.Seen(1_000)
    seen.remember("q1", 0)
    expect(seen.has("q1", 500)).toBe(true)
    // An attacker sending unique ids would otherwise grow this map forever at no cost to them.
    expect(seen.has("q1", 2_000)).toBe(false)

    for (let i = 0; i < 100; i++) seen.remember(`old-${i}`, 0)
    seen.prune(5_000)
    expect(seen.size).toBe(0)
  })
})

describe("CommunitySearch.widen", () => {
  test("a satisfied wave costs nothing more", () => {
    expect(CommunitySearch.widen({ results: 5, wanted: 5, asked: 3, available: 50 })).toBe(0)
  })

  test("🔴 widening DOUBLES rather than jumping to everyone", () => {
    // Two more cheap waves beat one expensive one: a query that gets answered is usually answered
    // early, and full fan-out on every unanswered query is the Gnutella traffic curve again.
    expect(CommunitySearch.widen({ results: 0, wanted: 5, asked: 3, available: 50 })).toBe(3)
    expect(CommunitySearch.widen({ results: 1, wanted: 5, asked: 6, available: 50 })).toBe(6)
    // Never more than the peers that actually exist.
    expect(CommunitySearch.widen({ results: 0, wanted: 5, asked: 8, available: 10 })).toBe(2)
    expect(CommunitySearch.widen({ results: 0, wanted: 5, asked: 10, available: 10 })).toBe(0)
  })
})

describe("a hostile TTL", () => {
  test("🔴 an incoming hop count is CLAMPED, not trusted", () => {
    /**
     * The hop limit is the first of the three controls this module exists to provide — "a query dies
     * after N hops; without it, throttling only delays a flood". But the hop count arrives INSIDE the
     * query, written by whoever sent it.
     *
     * A peer that sets `ttl: 1_000_000` therefore reaches every instance it can transitively touch
     * instead of a four-hop neighbourhood. Duplicate suppression stops each node forwarding twice, so
     * it is not the exponential re-broadcast that killed Gnutella — it is the OTHER half of that
     * failure: one cheap query conscripting the entire network, repeatable at whatever rate the
     * per-origin throttle allows. The limit binds only honest senders unless a receiver clamps it.
     */
    const seen = new CommunitySearch.Seen()
    const throttle = new CommunitySearch.Throttle()
    const hostile = { id: "q1", terms: "anything", ttl: 1_000_000, origin: "nid_them" }

    const verdict = CommunitySearch.consider(hostile, { self: "nid_us", seen, throttle, now: 1 })
    expect(verdict.forward).toBe(true)
    if (!verdict.forward) throw new Error("expected a forward")
    // Clamped to our own limit before the decrement — never `1_000_000 - 1`.
    expect(verdict.next.ttl).toBeLessThanOrEqual(CommunitySearch.DEFAULT_TTL)
    expect(verdict.next.ttl).toBe(CommunitySearch.DEFAULT_TTL - 1)
  })

  test("an honest hop count is left alone, and still dies", () => {
    const seen = new CommunitySearch.Seen()
    const throttle = new CommunitySearch.Throttle()
    // Below our limit: untouched, so a short query is not silently lengthened either.
    const short = CommunitySearch.consider(
      { id: "q2", terms: "x", ttl: 2, origin: "nid_them" },
      { self: "nid_us", seen, throttle, now: 1 },
    )
    expect(short.forward && short.next.ttl).toBe(1)
    // And at the floor it stops.
    expect(
      CommunitySearch.consider(
        { id: "q3", terms: "x", ttl: 1, origin: "nid_them" },
        { self: "nid_us", seen, throttle, now: 1 },
      ),
    ).toEqual({ forward: false, reason: "expired" })
  })
})
