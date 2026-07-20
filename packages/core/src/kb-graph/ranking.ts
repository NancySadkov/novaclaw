export * as MemoryRanking from "./ranking"

import type { SearchHit } from "./wasm-engine"

// P8b′ — RECALL ORDERING (notes/kb-graph-plan.md P8). Retrieval finds candidates; this decides which
// of them the model actually sees. The owner's requirement: a recent, authoritative statement must
// outrank an old, low-authority musing that happens to use matching words.
//
// Design constraints, each load-bearing:
//   • BOUNDED MULTIPLICATIVE. final = relevance × recency × authority, with both factors clamped to a
//     narrow band. Weighting may REORDER comparable hits; it must never let a barely-relevant recent
//     note bury a strongly-relevant old one. `maxSwing()` exposes that ceiling so a test can assert it
//     rather than trusting the constants.
//   • NEUTRAL WHEN UNINFORMATIVE. A missing timestamp scores 1 (not 0) and equal-provenance hits keep
//     their original order — a corpus with no authority/recency variance must come out unchanged.
//   • VALID time, not ingestion time. "Recent" means the fact became true recently (when it was said),
//     which is what `validAt` carries; re-ingesting an old document must not make it look fresh.
//   • RELEVANCE STAYS PRIMARY. This is a re-rank over candidates, not a replacement for matching.
//
// Deliberately NOT here yet: access FREQUENCY (needs new columns + the first versioned WASM DDL
// migration — P8a). Recency and authority need no schema change, so they ship first and prove the
// idea before that risk is taken.

export interface RankWeights {
  /** Days for the recency multiplier to fall halfway to the floor. */
  readonly halfLifeDays: number
  /** Multiplier for an infinitely old fact — never 0: age discounts, it does not erase. */
  readonly recencyFloor: number
  /** Curated/promoted (`relation: "core"`). */
  readonly authorityCore: number
  /** Deliberately recorded (a user/agent `remember`) — trusted more than a passive extraction. */
  readonly authorityStated: number
  /** Passively auto-extracted from conversation — the least authoritative tier. */
  readonly authorityDerived: number
}

export const DEFAULT_WEIGHTS: RankWeights = {
  halfLifeDays: 120,
  recencyFloor: 0.55,
  authorityCore: 1.5,
  authorityStated: 1.15,
  authorityDerived: 0.85,
}

const DAY_MS = 86_400_000

/** The widest possible relevance ratio this weighting can overturn. Above it, relevance always wins —
 *  the guarantee that ordering can't be hijacked by provenance alone. */
export const maxSwing = (w: RankWeights = DEFAULT_WEIGHTS): number =>
  (1 * w.authorityCore) / (w.recencyFloor * w.authorityDerived)

/** Exponential decay on VALID time, clamped to [floor, 1]. Unknown time ⇒ 1 (neutral, never penalised). */
export function recencyFactor(hit: SearchHit, nowMs: number, w: RankWeights = DEFAULT_WEIGHTS): number {
  if (!hit.validAt) return 1
  const at = Date.parse(hit.validAt)
  if (Number.isNaN(at)) return 1
  const ageDays = Math.max(0, (nowMs - at) / DAY_MS) // future-dated ⇒ treat as now, never a bonus
  const decay = Math.pow(0.5, ageDays / Math.max(1e-6, w.halfLifeDays))
  return w.recencyFloor + (1 - w.recencyFloor) * decay
}

/** Provenance tier. `core` (curated) > a deliberate write > a passive auto-extraction. */
export function authorityFactor(hit: SearchHit, w: RankWeights = DEFAULT_WEIGHTS): number {
  if (hit.relation === "core") return w.authorityCore
  if (hit.source === "auto-extract") return w.authorityDerived
  return w.authorityStated
}

export interface RankedHit extends SearchHit {
  /** The post-weighting score actually ordered on (relevance × recency × authority). */
  readonly ranked: number
}

/** Re-rank candidates. Stable: equal scores keep their retrieval order, so this is a no-op on a corpus
 *  with uniform provenance and age. Pure — `nowMs` is injected. */
export function rankHits(
  hits: ReadonlyArray<SearchHit>,
  nowMs: number,
  weights: RankWeights = DEFAULT_WEIGHTS,
): RankedHit[] {
  return hits
    .map((hit, index) => ({
      hit,
      index,
      ranked: hit.score * recencyFactor(hit, nowMs, weights) * authorityFactor(hit, weights),
    }))
    .sort((a, b) => b.ranked - a.ranked || a.index - b.index)
    .map(({ hit, ranked }) => ({ ...hit, ranked }))
}
