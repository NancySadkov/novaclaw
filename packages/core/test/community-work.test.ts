import { describe, expect, test } from "bun:test"
import { CommunityWork } from "@novaclaw/core/community/work"

/**
 * Community P5 — proof-of-work per message (`notes/spec/community-p2p.md`).
 *
 * **Measured 2026-08-14** on this machine, which is how `DEFAULT_DIFFICULTY` was chosen rather than
 * guessed:
 *
 * | difficulty | solve (avg) | verify | ceiling for one flooder |
 * |---|---|---|---|
 * | 12 | 5 ms | 0.9 µs | 222 msg/s |
 * | 14 | 19 ms | 0.9 µs | 51 msg/s |
 * | **16** | **49 ms** | **0.9 µs** | **20.5 msg/s** |
 * | 18 | 775 ms | 4 µs | 1.3 msg/s |
 * | 20 | 3154 ms | 4.6 µs | 0.3 msg/s |
 *
 * 16 is the pick: ~50 ms is invisible inside a send action, while the measured flood of **9 800
 * msg/s** drops to ~20 — a **478×** reduction. 18 costs 775 ms, which a person feels every time they
 * press send, and buys a factor no throttle could not also provide.
 *
 * 🔴 **What it does NOT buy, stated plainly.** This is not immunity. The ceiling is per CORE: an
 * attacker with 100 cores regains ~2 000 msg/s, and one renting a thousand regains more. PoW raises
 * the COST of flooding from free to metered; the per-origin throttle bounds what that money buys.
 * Neither alone is sufficient and the pair is not a solved problem — RLN remains the principled
 * answer if this proves inadequate.
 *
 * ⚠️ No timing assertions below. Wall-clock in a test measures the machine and the load, so it fails
 * on a busy CI box and passes on an idle one — the numbers above are measurements, recorded as
 * prose; the tests assert only what is deterministic.
 */

const SIGNATURE = "sig_" + "a".repeat(86)

describe("CommunityWork", () => {
  test("a solved nonce verifies, at a difficulty cheap enough to test", () => {
    const nonce = CommunityWork.solve(SIGNATURE, 8)
    expect(nonce).toBeDefined()
    expect(CommunityWork.verify(SIGNATURE, nonce!, 8)).toBe(true)
  })

  test("🔴 work does not transfer to another message", () => {
    // The whole point of binding to the signature: a flooder cannot solve once and reuse it, which
    // is what makes each message cost something.
    const nonce = CommunityWork.solve(SIGNATURE, 8)!
    expect(CommunityWork.verify("sig_" + "b".repeat(86), nonce, 8)).toBe(false)
  })

  test("🔴 a wrong or absent nonce fails, and a HARDER demand fails a weaker proof", () => {
    const nonce = CommunityWork.solve(SIGNATURE, 8)!
    expect(CommunityWork.verify(SIGNATURE, nonce + 1, 8)).toBe(false)
    // Work solved for 8 bits must not satisfy a receiver asking for 20 — otherwise the difficulty is
    // advisory and an attacker simply declares a low one.
    expect(CommunityWork.verify(SIGNATURE, nonce, 20)).toBe(false)
  })

  test("🔴 a hostile difficulty cannot make a receiver burn CPU", () => {
    const nonce = CommunityWork.solve(SIGNATURE, 8)!
    // Verification stays ONE hash whatever is asked, and absurd values are refused outright rather
    // than attempted — a receiver must never be the one paying for a sender's claim.
    expect(CommunityWork.verify(SIGNATURE, nonce, CommunityWork.MAX_DIFFICULTY + 1)).toBe(false)
    expect(CommunityWork.verify(SIGNATURE, nonce, 0)).toBe(false)
    expect(CommunityWork.verify(SIGNATURE, nonce, -5)).toBe(false)
  })

  test("garbage nonces are refused rather than throwing", () => {
    // A nonce arrives from a stranger, so every malformed shape must be a `false`, not a crash in
    // whatever loop is reading the channel.
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(CommunityWork.verify(SIGNATURE, bad, 8)).toBe(false)
  })

  test("solving reports failure instead of hanging", () => {
    // A difficulty this high will not be met in one attempt; the sender must get `undefined` and be
    // able to tell the user, rather than freezing the UI in an unbounded loop.
    expect(CommunityWork.solve(SIGNATURE, 32, 1)).toBeUndefined()
  })
})
