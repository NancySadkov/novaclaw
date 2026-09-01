export * as CommunityReconcile from "./reconcile"

import { createHash } from "node:crypto"

/**
 * Community P4 — reconciling two instances' logs (`notes/spec/community-p2p.md`).
 *
 * 🔴 The largest design risk in the program: **gossip delivers to whoever is ONLINE**, so a forum
 * whose messages vanish for anyone who was away is not a forum. Every instance keeping its own log
 * makes each one a partial archive with no central copy to seize — but only if two instances can
 * work out what the other is missing.
 *
 * The naive version is "send me your ids". At the retention bound of 5 000 messages per channel that
 * is 5 000 × 64 hex chars ≈ **320 KB per channel per sync**, paid by both sides, every time, almost
 * always to discover they already agree. That cost is why this is bucketed instead:
 *
 *   1. Both sides hash their ids into a fixed number of BUCKETS and exchange one digest per bucket
 *      (64 digests ≈ 4 KB, regardless of how many messages exist).
 *   2. Only buckets whose digests DIFFER need their id lists exchanged.
 *   3. Whoever is missing ids asks for those messages.
 *
 * Two instances that already agree exchange 4 KB and stop. One message apart, they exchange 4 KB plus
 * one bucket's ids. The cost tracks the DIFFERENCE, which is the property that makes syncing on every
 * reconnect affordable.
 *
 * Pure and transport-independent on purpose — same reason as the message envelope and the search
 * controls: the algorithm is cheaper to get right in a test than in a mesh.
 */

/** Buckets per channel. 64 keeps the summary ~4 KB while splitting 5 000 ids into ~78 each. */
export const BUCKETS = 64

/**
 * Which bucket an id falls in.
 *
 * ⚠️ Derived from the id's own bytes, so BOTH sides agree without coordinating. A bucketing that
 * depended on local state (insertion order, arrival time) would put the same message in different
 * buckets on two instances, and every bucket would then differ forever.
 */
export const bucketOf = (id: string, buckets: number = BUCKETS): number => {
  const first = parseInt(id.slice(0, 4), 16)
  return Number.isNaN(first) ? 0 : first % buckets
}

/**
 * One digest per bucket — the compact summary a peer sends.
 *
 * Ids are SORTED before hashing, because two instances hold the same messages in different local
 * orders. Without the sort, identical sets would produce different digests and every sync would
 * exchange everything.
 */
export const summarize = (ids: readonly string[], buckets: number = BUCKETS): string[] => {
  const grouped: string[][] = Array.from({ length: buckets }, () => [])
  for (const id of ids) grouped[bucketOf(id, buckets)]!.push(id)
  return grouped.map((bucket) => {
    if (bucket.length === 0) return ""
    const hash = createHash("sha256")
    for (const id of [...bucket].sort()) hash.update(id)
    return hash.digest("hex")
  })
}

/**
 * Buckets where the two summaries disagree — the only ones whose ids need exchanging.
 *
 * ⚠️ A summary of a different LENGTH is treated as wholly different rather than compared
 * positionally. Two instances running different bucket counts would otherwise silently compare
 * bucket 3 against bucket 3 of a different partition and conclude they agree.
 */
export const differing = (mine: readonly string[], theirs: readonly string[]): number[] => {
  if (mine.length !== theirs.length) return Array.from({ length: mine.length }, (_, i) => i)
  const out: number[] = []
  for (let i = 0; i < mine.length; i++) if (mine[i] !== theirs[i]) out.push(i)
  return out
}

/** The ids I hold in the given buckets — what I send once we know which buckets disagree. */
export const idsIn = (
  ids: readonly string[],
  buckets: readonly number[],
  total: number = BUCKETS,
): string[] => {
  const wanted = new Set(buckets)
  return ids.filter((id) => wanted.has(bucketOf(id, total)))
}

/**
 * Of the ids a peer offered, which do I not have?
 *
 * Deliberately returns what to REQUEST rather than what to send: a receiver decides what enters its
 * own log, which is the same rule `record` enforces — nothing arrives because a sender decided it
 * should.
 */
export const missing = (offered: readonly string[], mine: readonly string[]): string[] => {
  const held = new Set(mine)
  return offered.filter((id) => !held.has(id))
}

/**
 * 🔴 **The most ids one `/sync/ids` answer may carry** — Codex review P1, the amplifier.
 *
 * That endpoint returned every id in the buckets a caller named: about **335 KB for a ~200-byte
 * request**, from an anonymous door that pays no proof-of-work. The inbound 256 KB cap bounds one
 * request's size and says nothing about what it makes us send back.
 *
 * ⚠️ Truncating is SAFE for reconciliation, which is what makes a cap the right answer rather than
 * a cost: the bucket digests still differ after a partial answer, so the next round asks for what is
 * left and the exchange simply converges over more rounds. An honest catch-up of a room at its
 * 5,000-message retention bound now costs five rounds instead of one, and a hostile one gets a fifth
 * of the amplification per request.
 *
 * ⚠️ Four times `CommunitySync.MAX_MESSAGES_PER_REQUEST`, so a caller still learns more ids per round
 * than it can fetch messages for — otherwise the id exchange, the cheap half, would throttle the
 * expensive one. Written as a literal rather than an import because this module is pure and knows
 * nothing about the transport; `community-admission.test.ts` pins the relationship.
 */
export const MAX_IDS_PER_ANSWER = 1_024

/**
 * The bounded answer to one `/sync/ids` request — the exact bytes a peer receives.
 *
 * ⚠️ A function rather than two `slice`s at the call site, so the bound can be exercised over five
 * thousand ids in a test that costs nothing. The handler is a thin caller of this, which is the only
 * arrangement where "the door is bounded" is a claim a cheap test can make.
 */
export const answerIds = (held: readonly string[], asked: readonly number[]): string[] =>
  idsIn(held, asked.slice(0, BUCKETS)).slice(0, MAX_IDS_PER_ANSWER)
