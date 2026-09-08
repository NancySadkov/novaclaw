export * as MemoryRanking from "./ranking"


// RECALL ORDERING. Retrieval finds candidates; this decides which
// of them the model actually sees. The owner's requirement: a recent, authoritative statement must
// outrank an old, low-authority musing that happens to use matching words.
//
// Design constraints, each load-bearing:
//   • BOUNDED MULTIPLICATIVE. final = relevance × recency × authority × status × confidence, every
//     factor clamped to a narrow band. Weighting may REORDER comparable hits; it must never let a
//     barely-relevant recent note bury a strongly-relevant old one. `maxSwing()` exposes that ceiling
//     so a test can assert it rather than trusting the constants.
//   • NEUTRAL WHEN UNINFORMATIVE. A missing timestamp scores 1 (not 0), a missing confidence scores 1,
//     and equal-provenance hits keep their original order — a corpus with no variance must come out
//     unchanged.
//   • VALID time, not ingestion time. "Recent" means the fact became true recently (when it was said),
//     which is what `validAt` carries; re-ingesting an old document must not make it look fresh.
//   • RELEVANCE STAYS PRIMARY. This is a re-rank over candidates, not a replacement for matching.
//
// Deliberately NOT here yet: access FREQUENCY (needs new columns + the first versioned WASM DDL
// migration — P8a). Recency and authority need no schema change, so they ship first and prove the
// idea before that risk is taken.

/**
 * What ordering actually READS — deliberately structural rather than `SearchHit`.
 *
 * ⚠️ There are two `SearchHit` types on purpose: the engine's and `memory-client`'s engine-agnostic
 * contract. Naming either one here makes this module refuse the other, which is exactly what happened
 * the moment the row grew lifecycle columns: the ranker compiled against the engine's shape and the
 * runner passed the client's. Depending on the FIELDS instead means both satisfy it and neither has to
 * be converted.
 */
export interface RankableHit {
  readonly score: number
  /** Valid-time (ISO) — when the fact became true. Absent = unknown, and unknown is neutral. */
  readonly validAt?: string | undefined
  readonly relation?: string | undefined
  readonly source?: string | null | undefined
  readonly kind?: string | undefined
  readonly status?: string | undefined
  readonly confidence?: number | null | undefined
}

export interface RankWeights {
  /** Days for the recency multiplier to fall halfway to the floor. */
  readonly halfLifeDays: number
  /** Multiplier for an infinitely old fact — never 0: age discounts, it does not erase. */
  readonly recencyFloor: number
  /** Curated/promoted (`relation: "core"`). */
  readonly authorityCore: number
  /** Deliberately recorded (a user/agent `remember`) — trusted more than a passive extraction. */
  readonly authorityStated: number
  /** Passively auto-extracted from conversation — the least authoritative tier of a real memory. */
  readonly authorityDerived: number
  /**
   * A governed CLAIM — a statement filed against a subject and a question, which survived whatever
   * corrections came after it. The most answer-shaped thing in the store.
   */
  readonly authorityClaim: number
  /**
   * A raw ingested PASSAGE. 🔴 "Raw passages are source material, not hundreds of equal-weight
   * top-level memories" — one ingested manual is hundreds of rows, and at equal weight they drown
   * every deliberate fact the user ever saved. Demoted rather than removed: the shipped `kb ingest`
   * promise is "ingest a big manual, then search it", and a passage nobody can retrieve breaks it.
   *
   * ⚠️ The heavy lifting is at RETRIEVAL, not here — `wasm-engine.ts` caps how much of a page passages
   * may take, because a fact crowded out of the candidate pool is not slow to appear, it is absent.
   * This weight only orders what survived that.
   */
  readonly authorityPassage: number
  /** A claim whose CITATION moved. Still the only answer we have, so discounted, never hidden. */
  readonly statusNeedsReview: number
  /** Multiplier at `confidence: 0`. Confidence lifts toward 1 at `confidence: 1`; null is neutral. */
  readonly confidenceFloor: number
}

export const DEFAULT_WEIGHTS: RankWeights = {
  halfLifeDays: 120,
  recencyFloor: 0.55,
  authorityCore: 1.5,
  authorityClaim: 1.25,
  authorityStated: 1.15,
  authorityDerived: 0.85,
  authorityPassage: 0.7,
  statusNeedsReview: 0.85,
  confidenceFloor: 0.9,
}

const DAY_MS = 86_400_000

/**
 * The widest possible relevance ratio this weighting can overturn. Above it, relevance always wins —
 * the guarantee that ordering can't be hijacked by provenance alone.
 *
 * ⚠️ It multiplies EVERY factor's best case over EVERY factor's worst case, so a signal added without
 * being added here would quietly raise the real ceiling while the reported one stayed put. The
 * ranking test asserts both sides of it against hits built at those extremes, which is what makes
 * this a bound rather than a comment.
 *
 * 🔴 **It WIDENED from ~3.2 to ~5.1 when the lifecycle landed**, and that was a decision, not a
 * slip. Status and confidence are required signals ("rank relevance with status, freshness,
 * confidence and valid-time recency"), and every multiplicative factor widens this by construction.
 * Two things keep it from running away: kind is folded into the SINGLE authority tier below rather
 * than becoming a parallel multiplier, and the two new factors are deliberately shallow (0.85, 0.9)
 * — shallow enough to break ties, never to decide an answer on their own.
 */
export const maxSwing = (w: RankWeights = DEFAULT_WEIGHTS): number =>
  w.authorityCore / (w.recencyFloor * w.authorityPassage * w.statusNeedsReview * w.confidenceFloor)

/** Exponential decay on VALID time, clamped to [floor, 1]. Unknown time ⇒ 1 (neutral, never penalised). */
export function recencyFactor(hit: RankableHit, nowMs: number, w: RankWeights = DEFAULT_WEIGHTS): number {
  if (!hit.validAt) return 1
  const at = Date.parse(hit.validAt)
  if (Number.isNaN(at)) return 1
  const ageDays = Math.max(0, (nowMs - at) / DAY_MS) // future-dated ⇒ treat as now, never a bonus
  const decay = Math.pow(0.5, ageDays / Math.max(1e-6, w.halfLifeDays))
  return w.recencyFloor + (1 - w.recencyFloor) * decay
}

/**
 * HOW MUCH THIS ROW IS WORTH BELIEVING — one tier, first match wins.
 *
 * ⚠️ Kind lives HERE rather than in a second multiplier of its own, and that is the difference
 * between a bounded weighting and a runaway one: two factors that both mean "how far do we trust
 * this" multiply their extremes together, and `maxSwing` had jumped to 9.5 before this was folded
 * back into one tier.
 *
 * Order matters. `core` is a human's curation and outranks everything. A raw passage is source
 * material whatever else is true of it. An auto-extracted CLAIM is still a guess, so extraction's
 * discount is checked before the claim bonus — otherwise the lifecycle would launder a passive
 * extraction into the store's most trusted tier merely by giving it a subject.
 */
export function authorityFactor(hit: RankableHit, w: RankWeights = DEFAULT_WEIGHTS): number {
  if (hit.relation === "core") return w.authorityCore
  if (hit.kind === "passage") return w.authorityPassage
  if (hit.source === "auto-extract") return w.authorityDerived
  if (hit.kind === "claim") return w.authorityClaim
  return w.authorityStated
}

/**
 * Lifecycle status.
 *
 * ⚠️ Only `needs_review` has a factor, and that is the whole point: `superseded` and `archived` never
 * reach the ranker because retrieval excluded them (`wasm-engine.ts`, `KbClaim.RECALL_STATUSES`).
 * Separating current truth from history is a FILTER, not a discount — a big enough relevance score
 * would eventually out-multiply any penalty, and "eventually the wrong answer wins" is not a
 * separation.
 */
export function statusFactor(hit: RankableHit, w: RankWeights = DEFAULT_WEIGHTS): number {
  return hit.status === "needs_review" ? w.statusNeedsReview : 1
}

/** Stated confidence, mapped into [floor, 1]. Null/absent is 1 — the neutral, never-penalised case,
 *  which matters because no writer set this field for the store's whole history. */
export function confidenceFactor(hit: RankableHit, w: RankWeights = DEFAULT_WEIGHTS): number {
  const value = hit.confidence
  if (value === null || value === undefined || Number.isNaN(value)) return 1
  const clamped = Math.min(1, Math.max(0, value))
  return w.confidenceFloor + (1 - w.confidenceFloor) * clamped
}

export type RankedHit<T extends RankableHit = RankableHit> = T & {
  /** The post-weighting score actually ordered on. */
  readonly ranked: number
}

/** Re-rank candidates. Stable: equal scores keep their retrieval order, so this is a no-op on a corpus
 *  with uniform provenance, kind, status and age. Pure — `nowMs` is injected. */
export function rankHits<T extends RankableHit>(
  hits: ReadonlyArray<T>,
  nowMs: number,
  weights: RankWeights = DEFAULT_WEIGHTS,
): RankedHit<T>[] {
  return hits
    .map((hit, index) => ({
      hit,
      index,
      ranked:
        hit.score *
        recencyFactor(hit, nowMs, weights) *
        authorityFactor(hit, weights) *
        statusFactor(hit, weights) *
        confidenceFactor(hit, weights),
    }))
    .sort((a, b) => b.ranked - a.ranked || a.index - b.index)
    .map(({ hit, ranked }) => ({ ...hit, ranked }))
}
