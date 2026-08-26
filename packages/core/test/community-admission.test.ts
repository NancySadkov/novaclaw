import { describe, expect, test } from "bun:test"
import { CommunityAdmission } from "@novaclaw/core/community/admission"

/**
 * 🔴 Codex review 2026-08-17, P1 — **the anonymous sync surface was an unrate-limited CPU and
 * bandwidth amplifier.**
 *
 * The doors that STORE something charge proof-of-work. The doors that merely READ charge nothing, by
 * design — catching up must be cheap — and they multiply: ~335 KB from `/sync/ids` for a ~200-byte
 * request, a 64-bucket digest recomputed over 5,000 ids on every `/sync/summary`, the whole
 * succession table for an ~80-byte GET. The 256 KB inbound cap bounds one request's size and says
 * nothing about their number.
 *
 * ⚠️ `now` is a parameter throughout, so the windows are exercised by arithmetic rather than by
 * sleeping. A rate limiter whose test takes a minute is a rate limiter nobody runs.
 */
describe("the ingress governor", () => {
  const at = (state: CommunityAdmission.State, source: string, now: number) => {
    const refusal = CommunityAdmission.admit(state, source, now)
    if (refusal === undefined) CommunityAdmission.release(state)
    return refusal
  }

  test("🔴 one source cannot spend the instance's whole minute", () => {
    const state = CommunityAdmission.make()
    for (let i = 0; i < CommunityAdmission.PER_SOURCE_PER_MINUTE; i++)
      expect(at(state, "1.2.3.4", 1_000), `request ${i} is within the allowance`).toBeUndefined()
    expect(at(state, "1.2.3.4", 1_000)).toBe("rate")

    // A DIFFERENT source is unaffected — the limit is per caller, not a queue everyone shares.
    expect(at(state, "5.6.7.8", 1_000)).toBeUndefined()

    // …and the window rolls, so a peer that waited is served rather than punished.
    expect(at(state, "1.2.3.4", 1_000 + 60_000)).toBeUndefined()
  })

  test("🔴 a source's REFUSED requests do not spend the instance's global allowance", () => {
    /**
     * 🔴 Codex review, NC-SEC-004. The governor charged the global bucket BEFORE it consulted the
     * source bucket, so every request one address made past its own limit still burned a global
     * slot. One address sending `GLOBAL_PER_MINUTE` requests was admitted `PER_SOURCE_PER_MINUTE`
     * times and left the instance-wide counter full — a remote off switch for every other peer,
     * from one socket, with no botnet and no proof of work.
     *
     * ⚠️ The neighbouring "one source cannot spend the instance's whole minute" test sent exactly
     * ONE request past the source allowance, so it never reached the global ceiling and passed
     * against the defect. The bound is only exercised by overspending it.
     */
    const state = CommunityAdmission.make()
    let admitted = 0
    for (let i = 0; i < CommunityAdmission.GLOBAL_PER_MINUTE; i++)
      if (at(state, "1.2.3.4", 1_000) === undefined) admitted++
    expect(admitted).toBe(CommunityAdmission.PER_SOURCE_PER_MINUTE)

    // The whole point: a well-behaved peer arriving after the flood is still served.
    expect(at(state, "5.6.7.8", 1_000)).toBeUndefined()

    // And the global counter holds only what was actually ADMITTED, not what was attempted.
    expect(state.global.count).toBe(CommunityAdmission.PER_SOURCE_PER_MINUTE + 1)
  })

  test("🔴 many sources cannot walk past the per-source limit — the global ceiling", () => {
    /**
     * Per-source alone is not a bound: an attacker arrives from many addresses, and peer exchange
     * hands our address to everybody by design. This is the number that keeps a home machine's fan
     * quiet, and it is what a user is consenting to when they join.
     */
    const state = CommunityAdmission.make()
    let admitted = 0
    for (let i = 0; i < CommunityAdmission.GLOBAL_PER_MINUTE * 2; i++)
      if (at(state, `10.0.${Math.floor(i / 200)}.${i % 200}`, 2_000) === undefined) admitted++
    expect(admitted).toBe(CommunityAdmission.GLOBAL_PER_MINUTE)
  })

  test("🔴 concurrency is bounded even when the rate is not spent", () => {
    // The rate limits requests per minute; this limits how many are executing at once, which is what
    // actually decides whether a burst of expensive reads can pin the CPU.
    const state = CommunityAdmission.make()
    for (let i = 0; i < CommunityAdmission.MAX_CONCURRENT; i++)
      expect(CommunityAdmission.admit(state, `src-${i}`, 3_000)).toBeUndefined()
    expect(CommunityAdmission.admit(state, "one-more", 3_000)).toBe("busy")

    // Releasing one lets the next in — and a handler that dies must release too, which is why the
    // middleware uses `ensuring` rather than releasing after the handler.
    CommunityAdmission.release(state)
    expect(CommunityAdmission.admit(state, "one-more", 3_000)).toBeUndefined()
  })

  test("🔴 the source table is BOUNDED — the key is attacker-chosen", () => {
    /**
     * A map keyed on remote address with no cap is the same disk-fill shape as the peer table one
     * layer down: an attacker with a /64 of IPv6 mints a fresh key per request. Eviction costs those
     * sources their history and never costs us memory.
     */
    const state = CommunityAdmission.make()
    for (let i = 0; i < 10_000; i++) at(state, `2001:db8::${i.toString(16)}`, 4_000)
    expect(state.sources.size).toBeLessThanOrEqual(4_096)
  })

  test("⚠️ an unknown source is one shared bucket, never an exemption", () => {
    // If a missing remote address meant "unlimited", it would be the cheapest way past the limiter.
    const state = CommunityAdmission.make()
    let admitted = 0
    for (let i = 0; i < CommunityAdmission.PER_SOURCE_PER_MINUTE * 2; i++)
      if (at(state, "unknown", 5_000) === undefined) admitted++
    expect(admitted).toBe(CommunityAdmission.PER_SOURCE_PER_MINUTE)
  })
})
