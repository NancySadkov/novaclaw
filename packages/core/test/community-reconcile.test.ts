import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { CommunityReconcile } from "@novaclaw/core/community/reconcile"

/**
 * Community P4 — log reconciliation (`todo/community-p2p.md`).
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
    expect(CommunityReconcile.differing(CommunityReconcile.summarize(mine), CommunityReconcile.summarize(theirs))).toEqual([])
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
    const buckets = CommunityReconcile.differing(
      CommunityReconcile.summarize([]),
      CommunityReconcile.summarize(theirs),
    )
    const wanted = CommunityReconcile.missing(CommunityReconcile.idsIn(theirs, buckets), [])
    // The fresh-install case: a new instance joining a channel with history.
    expect(wanted.sort()).toEqual([...theirs].sort())
  })
})
