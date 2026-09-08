import { describe, expect, test } from "bun:test"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunityWork } from "@novaclaw/core/community/work"
import { readFileSync } from "node:fs"

/**
 * Community P5 — throttled broadcast search (`notes/spec/community-p2p.md`).
 *
 * 🔴 These are the three controls whose absence collapsed Gnutella in 2001. Each test below is a way
 * the network eats itself, so each removal has been checked to make the corresponding test fail.
 */

/**
 * A query with its work solved, which is now what a query IS. ⚠️ Every helper here goes through
 * `proven` so that no test can accidentally assert about a query no peer would accept.
 */
const proven = (over: Partial<CommunitySearch.Query> = {}): CommunitySearch.Query => {
  const base = { id: "q1", terms: "gguf 7b", ttl: CommunitySearch.DEFAULT_TTL, origin: "nid_asker", ...over }
  if (typeof over.nonce === "number") return base as CommunitySearch.Query
  const nonce = CommunityWork.solve(CommunitySearch.workBytes(base))
  if (nonce === undefined) throw new Error("could not solve the query work")
  return { ...base, nonce }
}

const query = proven

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
    // ⚠️ Each relabelled hop is RE-PROVEN, because the id is under the work — which is itself the
    // point: an attacker cannot relabel one proven query into a fresh one for free.
    let hops = 0
    let current = query({ ttl: 3 })
    for (let i = 0; i < 10; i++) {
      const verdict = CommunitySearch.consider(current, context({ self: `nid_hop${i}` }))
      if (!verdict.forward) break
      hops++
      current = proven({ ...verdict.next, id: `q-${i}`, nonce: undefined })
    }
    expect(hops).toBe(2)
  })

  test("🔴 the throttle is keyed on ORIGIN, not on the sender", () => {
    const ctx = context()
    // A flooder relaying its own queries through different neighbours would get a fresh budget per
    // neighbour if this were keyed on whoever handed it over. Distinct ids, one origin.
    const verdicts = Array.from({ length: 14 }, (_, i) => CommunitySearch.consider(query({ id: `flood-${i}` }), ctx))
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
    const hostile = proven({ id: "q1", terms: "anything", ttl: 1_000_000, origin: "nid_them" })

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
    const short = CommunitySearch.consider(proven({ id: "q2", terms: "x", ttl: 2, origin: "nid_them" }), {
      self: "nid_us",
      seen,
      throttle,
      now: 1,
    })
    expect(short.forward && short.next.ttl).toBe(1)
    // And at the floor it stops.
    expect(
      CommunitySearch.consider(proven({ id: "q3", terms: "x", ttl: 1, origin: "nid_them" }), {
        self: "nid_us",
        seen,
        throttle,
        now: 1,
      }),
    ).toEqual({ forward: false, reason: "expired" })
  })

  test("🔴 a VARYING origin no longer buys a free flood — the throttle could not see it", () => {
    /**
     * The throttle is the owner's named control and it was carrying the whole weight alone, which it
     * cannot: `origin` is an unverified string the caller writes. Measured before the fix — 300,000
     * queries with a fresh origin each were refused **0** times, while the same origin repeated
     * 1,000 times was refused 990. The control worked perfectly against an attacker who cooperated
     * by not varying a string.
     *
     * ⚠️ Search was the ONE door here with no cost attached. Every other one already used this exact
     * primitive, and an unthrottled query fans out to up to `MAX_ASKED` peers — so a free request
     * bought a 32x amplification.
     */
    const ctx = context()
    const unproven = Array.from({ length: 20 }, (_, i) => ({
      id: `flood-${i}`,
      terms: "x",
      ttl: 3,
      origin: `nid_fresh-${i}`,
      nonce: 0,
    }))
    const verdicts = unproven.map((q) => CommunitySearch.consider(q, ctx))
    expect(verdicts.every((v) => !v.forward && v.reason === "unproven")).toBe(true)

    // 🔴 And NOTHING of ours was touched: an unproven query must not reach `seen` or the throttle,
    // because both are maps keyed on strings the caller chose. A defence that stores what it refuses
    // is the flood's storage.
    expect(ctx.seen.size).toBe(0)

    // The same queries, with the work actually done, are ordinary traffic again.
    const honest = unproven.map((q) => CommunitySearch.consider(proven({ ...q, nonce: undefined }), ctx))
    expect(honest.some((v) => v.forward)).toBe(true)
  })

  test("🔴 the throttle's own table has a ceiling", () => {
    // Proof of work is what stops the flood now, but this map is still keyed on a caller's string,
    // and a defence that grows without bound is the shape of half the findings in this subsystem.
    const throttle = new CommunitySearch.Throttle(10, 10_000, 100)
    for (let i = 0; i < 5_000; i++) throttle.allow(`nid_origin-${i}`, 1)
    expect(throttle.size).toBeLessThanOrEqual(100)
  })

  test("🔴 the dedup set has a CEILING — its prune was never called", () => {
    /**
     * `Seen.prune` is documented as "called periodically, not per query", and a grep for its callers
     * finds none. So the only expiry was the lazy one inside `has`, which fires when an id is asked
     * about a SECOND time — and a flooder never repeats an id, because repeating is exactly what
     * dedup catches. Their entries were the ones nothing could ever reach.
     *
     * ⚠️ The same trap as peer eviction ordering by a `last_seen_at` that nothing wrote: present,
     * correct, unreachable. A bound whose signal has no source is decoration, and a ceiling is the
     * version that needs no caller.
     */
    const seen = new CommunitySearch.Seen(CommunitySearch.SEEN_TTL_MS, 500)
    for (let i = 0; i < 20_000; i++) seen.remember(`q-${i}`, 1)
    expect(seen.size).toBeLessThanOrEqual(500)
    // ⚠️ And it still DEDUPES — a ceiling that broke the control it bounds would be worse than the
    // leak, because duplicate suppression is what stops exponential re-broadcast in a cyclic graph.
    seen.remember("recent", 1)
    expect(seen.has("recent", 1)).toBe(true)
  })

  test("🔴 EVERY module that dials a peer shares the answer ceiling", () => {
    /**
     * The outbound size limit was written for `sync.ts`'s `ask` and stopped there. `search.ts` has
     * its own `askPeer`, which kept calling `response.json` with no bound at all — a rule applied
     * per caller, which is the mistake this subsystem records over and over: blocking missing from
     * two doors, the airgap from ten, `MAX_PEERS_ASKED` never reaching `sendDirect`.
     *
     * ⚠️ Asserted as "every dialling file uses the SHARED helper" rather than "each has a check",
     * because two independent checks are exactly the state that let this happen — they agree until
     * somebody tunes one.
     */
    /**
     * ⚠️ **Re-pointed 2026-09-01 (), and it now asserts something STRONGER.** It used to
     * require each dialler to contain `answerTooLarge(` — which both did, and `search.ts` still
     * passed the 4 MB `sync/messages` default to it, so the guard was green while the drift it
     * exists to catch was live. Sharing a CONSTANT that each caller may forget to pass is sharing it
     * in name only.
     *
     * The dial itself now lives in `transport.ts` as `askPeerJson`, whose `ceilingBytes` is a
     * REQUIRED field — so a dialler cannot omit the ceiling and cannot silently inherit a default
     * derived for a different shape. This asserts the call, and that each caller states its own
     * ceiling at the call site.
     */
    const dialers = ["sync.ts", "search.ts"]
    for (const file of dialers) {
      const source = readFileSync(new URL(`../src/community/${file}`, import.meta.url), "utf8")
      expect(source, `${file} reads a peer answer without the shared dial`).toContain("askPeerJson(")
      expect(source, `${file} does not state its own ceiling`).toContain("ceilingBytes")
      // The ceiling must be the one in transport.ts, not a local copy that can drift.
      expect(source, `${file} declares its own copy of the limit`).not.toContain("MAX_PEER_RESPONSE_BYTES = ")
      // 🔴 And the raw read must not come back: a second hand-rolled dial beside the shared one is
      // exactly the state this test was written for.
      expect(source, `${file} reads response.json directly again`).not.toContain("response.json")
    }

    // And the search answer is bounded by COUNT too — bytes do not bound how many names arrive.
    const search = readFileSync(new URL("../src/community/search.ts", import.meta.url), "utf8")
    expect(search).toContain("slice(0, MAX_CHANNELS_PER_ANSWER)")
  })
})
