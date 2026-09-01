import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"
import { CommunitySync } from "@novaclaw/core/community/sync"

/**
 * Community P4 — log reconciliation (`notes/spec/community-p2p.md`).
 *
 * The property that matters is not correctness alone but COST: two instances that already agree must
 * exchange almost nothing, or syncing on every reconnect is unaffordable and history quietly stops
 * being replicated.
 */

/** Realistic ids: sha256 hex, the shape `CommunityChannels.messageID` produces. */
const id = (n: number) => createHash("sha256").update(`message-${n}`).digest("hex")
const ids = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => id(from + i))

describe("CommunityReconcile", () => {
  test("identical logs differ in NO bucket — the common case costs one summary", () => {
    const mine = ids(0, 500)
    // Shuffled, because two instances hold the same messages in different local orders. If order
    // mattered, agreeing instances would exchange everything on every sync.
    const theirs = [...mine].reverse()
    expect(
      CommunityReconcile.differing(CommunityReconcile.summarize(mine), CommunityReconcile.summarize(theirs)),
    ).toEqual([])
  })

  test("🔴 one message apart touches ONE bucket, not all of them", () => {
    const mine = ids(0, 500)
    const theirs = [...mine, id(999)]
    const buckets = CommunityReconcile.differing(
      CommunityReconcile.summarize(mine),
      CommunityReconcile.summarize(theirs),
    )
    // This is the whole economic argument: cost tracks the DIFFERENCE, not the log size.
    expect(buckets).toHaveLength(1)
    expect(buckets[0]).toBe(CommunityReconcile.bucketOf(id(999)))
  })

  test("a full sync exchanges only the differing buckets' ids, then the gap", () => {
    const mine = ids(0, 300)
    const theirs = [...ids(0, 300), ...ids(300, 310)]

    const buckets = CommunityReconcile.differing(
      CommunityReconcile.summarize(mine),
      CommunityReconcile.summarize(theirs),
    )
    const offered = CommunityReconcile.idsIn(theirs, buckets)
    const wanted = CommunityReconcile.missing(offered, mine)

    // Exactly the ten they have and I do not — no more, and nothing I already hold.
    expect(wanted.sort()).toEqual(ids(300, 310).sort())
    // And the ids exchanged are a fraction of the log, not all of it.
    expect(offered.length).toBeLessThan(theirs.length / 2)
  })

  test("🔴 bucketing derives from the ID, so both sides agree without coordinating", () => {
    // A bucketing that depended on insertion order or arrival time would place the same message
    // differently on two instances, and then every bucket would differ forever.
    for (const n of [1, 42, 999, 12_345]) {
      expect(CommunityReconcile.bucketOf(id(n))).toBe(CommunityReconcile.bucketOf(id(n)))
      expect(CommunityReconcile.bucketOf(id(n))).toBeLessThan(CommunityReconcile.BUCKETS)
    }
  })

  test("🔴 mismatched bucket COUNTS are wholly different, never compared positionally", () => {
    const mine = CommunityReconcile.summarize(ids(0, 100), 64)
    const theirs = CommunityReconcile.summarize(ids(0, 100), 32)
    // Same messages, different partitions. Comparing index-for-index would conclude "we agree" for
    // buckets that describe different id ranges — a silent, permanent data loss.
    expect(CommunityReconcile.differing(mine, theirs)).toHaveLength(64)
  })

  test("an empty log asks for everything the peer has, and offers nothing back", () => {
    const theirs = ids(0, 50)
    const buckets = CommunityReconcile.differing(CommunityReconcile.summarize([]), CommunityReconcile.summarize(theirs))
    const wanted = CommunityReconcile.missing(CommunityReconcile.idsIn(theirs, buckets), [])
    // The fresh-install case: a new instance joining a channel with history.
    expect(wanted.sort()).toEqual([...theirs].sort())
  })
})

/**
 * 🔴 Codex review 2026-08-17, P1 — **`/sync/ids` returned ~335 KB for a ~200-byte request.**
 *
 * The door pays no proof-of-work by design (catching up must be cheap) and answered every id in the
 * buckets a caller named, from a table holding up to 5,000. The 256 KB inbound cap bounds one
 * request's size and says nothing about what it makes us send back.
 */
describe("what one id answer may cost us (Codex P1)", () => {
  test("🔴 the answer is bounded however many ids we hold and however many buckets are asked for", () => {
    const held = ids(0, 5_000)
    const everyBucket = Array.from({ length: CommunityReconcile.BUCKETS }, (_, i) => i)
    expect(CommunityReconcile.idsIn(held, everyBucket).length, "unbounded, this is the whole table").toBe(5_000)
    expect(CommunityReconcile.answerIds(held, everyBucket).length).toBe(CommunityReconcile.MAX_IDS_PER_ANSWER)

    // A prober naming thousands of buckets that cannot exist gets no more work out of us.
    const absurd = Array.from({ length: 5_000 }, (_, i) => i)
    expect(CommunityReconcile.answerIds(held, absurd).length).toBe(CommunityReconcile.MAX_IDS_PER_ANSWER)
  })

  test("🔴 asking for the SAME buckets again is a livelock — why the asker chunks", () => {
    /**
     * 🔴 Found by writing this test, and it corrected the fix: a truncated answer is NOT
     * self-correcting. Re-asking for the same differing buckets returns the same first N ids, so the
     * exchange stalls exactly at the cap — 1,024 of 3,000, forever. The comment on the handler said
     * otherwise ("the next round asks for the rest") and was wrong.
     */
    const theirs = ids(0, 3_000)
    const mine: string[] = []
    for (let round = 0; round < 3; round++) {
      const differing = CommunityReconcile.differing(
        CommunityReconcile.summarize(mine),
        CommunityReconcile.summarize(theirs),
      )
      for (const id of CommunityReconcile.answerIds(theirs, differing)) if (!mine.includes(id)) mine.push(id)
    }
    expect(mine.length, "three rounds of the naive loop buy exactly one answer").toBe(
      CommunityReconcile.MAX_IDS_PER_ANSWER,
    )
  })

  test("🔴 chunking the buckets CONVERGES — the shape the asker actually uses", () => {
    /**
     * What makes a cap and convergence coexist is asking for FEWER BUCKETS, so each answer is
     * complete for the buckets it covers. `CommunitySync.BUCKETS_PER_REQUEST` is that chunk, and
     * this walks the real loop: summarise, diff, ask in chunks, repeat.
     */
    const theirs = ids(0, 3_000)
    const mine: string[] = []
    for (let round = 0; round < 20 && mine.length < theirs.length; round++) {
      const differing = CommunityReconcile.differing(
        CommunityReconcile.summarize(mine),
        CommunityReconcile.summarize(theirs),
      )
      const before = mine.length
      for (let i = 0; i < differing.length; i += CommunitySync.BUCKETS_PER_REQUEST) {
        const chunk = differing.slice(i, i + CommunitySync.BUCKETS_PER_REQUEST)
        for (const id of CommunityReconcile.answerIds(theirs, chunk)) if (!mine.includes(id)) mine.push(id)
      }
      expect(mine.length, "each round must make progress or the loop is a livelock").toBeGreaterThan(before)
    }
    expect(mine.length).toBe(theirs.length)

    /**
     * ⚠️ And the chunk must be small enough that a FULL room answers COMPLETELY, or the livelock
     * above returns through the back door. Measured against the fullest bucket of a real 5,000-id
     * set rather than the average, because ids do not distribute evenly and the average is the
     * number that would let this pass while the product stalls.
     */
    const full = ids(0, 5_000)
    const widest = Math.max(
      ...Array.from(
        { length: CommunityReconcile.BUCKETS },
        (_, bucket) => CommunityReconcile.idsIn(full, [bucket]).length,
      ),
    )
    expect(widest * CommunitySync.BUCKETS_PER_REQUEST).toBeLessThan(CommunityReconcile.MAX_IDS_PER_ANSWER)
  })
})
