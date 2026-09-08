export * as MemoryPrunePolicy from "./prune-policy"

import type { MemoryAccessLedger } from "./access-ledger"
import type { MemoryClient } from "./memory-client"

/**
 * WHAT A MEMORY IS WORTH KEEPING, once there is a record of what it ever did.
 *
 * 🔴 **The point of this file is that AGE is the tiebreak and nothing else.** Before the access
 * ledger there was no other axis to sort on: the retired engine-local `WasmMemory.prune` tiered by
 * `source` and then fell through to `t_created`, because "no writer ever sets `confidence`"
 * (measured 2026-07-20 — every occurrence is `input.confidence ?? null` plumbing) left age as the
 * only column with any spread in it. That method is gone; this file and `memory.ts`'s
 * `forgetOverCap` replaced it. A store pruned mainly by age forgets the fact you rely on
 * every week and keeps the passage nobody has ever retrieved, which is the exact failure the
 * forgetting policy exists to avoid.
 *
 * The five signals the roadmap names, and what each is actually reading:
 *
 *   · **source / re-derivability** — an `ingest` passage can be re-ingested from the document it came
 *     from (idempotent by content hash), so losing it costs a re-ingest. A deliberate `kb remember`
 *     cannot be re-derived from anything; losing it is losing the only copy.
 *   · **confidence** — what the writer claimed. Still mostly null, so it moves a candidate a little
 *     and decides nothing on its own.
 *   · **lifecycle** — `archived` is a person saying "put this away"; `needs_review` is evidence that
 *     moved under a claim. Both are weaker than a plain `active` claim.
 *   · **access recency** — when recall last handed it to anybody.
 *   · **usefulness** — whether it reached the model, whether a person vouched for it, and whether the
 *     answers it gave had to be corrected.
 *
 * ⚠️ **Two hard protections sit ABOVE the score**, because a score can always be out-argued by a big
 * enough number somewhere else and these two must not be:
 *
 *   1. **A vouched-for memory is never a victim.** "Useful memories are protected" is the roadmap's
 *      wording and it is a promise, not a weight.
 *   2. **A `core` memory is never a victim**, exactly as before — the curated relation is what the
 *      forgetting pass has always refused to touch.
 *
 * ⚠️ **A never-recalled memory is NOT automatically the first to go.** It is the *cheapest* thing to
 * lose among things that also look re-derivable, which is why absence of use lowers a score rather
 * than short-circuiting it. Everything is never-recalled the day it is written, and a policy that
 * read that as worthless would delete the newest half of the store on the first pass.
 */

/** Everything the policy reads about one memory, with no body — see `MemoryClient.CandidateRow`. */
export type Candidate = MemoryClient.CandidateRow

/** What the ledger knows about it. Absent = recall has never returned it. */
export type Usage = MemoryAccessLedger.Usage

export interface Scored {
  readonly id: string
  /** Higher survives. Age never enters this number; it is applied afterwards, as the tiebreak. */
  readonly score: number
  readonly protectedFor?: "vouched" | "core"
}

const DAY = 24 * 60 * 60 * 1000

/**
 * How re-derivable the thing is, i.e. what losing it actually costs.
 *
 * Kept identical to the engine's existing three tiers so this is a REFINEMENT of the shipped policy
 * rather than a second, differently-opinionated one sitting beside it.
 */
const sourceWeight = (source: string | null): number => (source === "ingest" ? 0 : source === "auto-extract" ? 1 : 2)

const lifecycleWeight = (status: Candidate["status"]): number => {
  switch (status) {
    // A person put it away. Keeping it costs recall nothing (it is already out of `RECALL_STATUSES`),
    // so it is a fine thing to forget first — but it was still a deliberate act, so it is not free.
    case "archived":
      return -1
    // Its evidence moved. That is a reason to look at it, not a reason to keep it above a healthy one.
    case "needs_review":
      return -0.5
    case "superseded":
      return -1
    default:
      return 0
  }
}

/**
 * How recently recall handed it to anybody.
 *
 * A step function rather than a decay curve on purpose: the thresholds are readable, and the shape of
 * a curve would imply a precision the underlying signal does not have — a memory recalled 8 days ago
 * and one recalled 6 days ago are the same thing to a person.
 */
const recencyWeight = (usage: Usage | undefined, now: number): number => {
  if (usage === undefined) return 0
  const age = now - usage.lastAccessedAt
  if (age <= 7 * DAY) return 1.5
  if (age <= 30 * DAY) return 0.75
  return 0.25
}

const usefulnessWeight = (usage: Usage | undefined): number => {
  if (usage === undefined) return 0
  // Reaching the model is worth more than being retrieved: the store hands back a pool and only some
  // of it survives the turn's budget, so `uses` is the half that actually influenced an answer.
  const used = usage.uses > 0 ? 1 : 0
  const seen = Math.min(usage.accesses, 5) * 0.2
  /**
   * A memory whose answers had to be corrected is a memory that misled somebody.
   *
   * ⚠️ Weighted at 1.0 — the same as reaching the model at all — and the arithmetic that produces is
   * worth stating rather than leaving to be discovered: a frequently-recalled memory sits about 3.5
   * points above a never-recalled peer of the same provenance, so it takes THREE OR FOUR corrections
   * to sink below it. That is deliberate. One correction is an ordinary fact update — the user moved
   * house — and a policy that treated it as evidence of noise would forget the store's most active
   * facts fastest. "Repeatedly" is the word the roadmap uses, and this is what it costs.
   */
  const corrections = usage.corrections
  return used + seen - corrections
}

export const score = (candidate: Candidate, usage: Usage | undefined, now: number): Scored => {
  if (candidate.relation === "core") return { id: candidate.id, score: Number.POSITIVE_INFINITY, protectedFor: "core" }
  if (usage !== undefined && usage.useful > 0)
    return { id: candidate.id, score: Number.POSITIVE_INFINITY, protectedFor: "vouched" }
  return {
    id: candidate.id,
    score:
      sourceWeight(candidate.source) +
      (candidate.confidence ?? 0) +
      lifecycleWeight(candidate.status) +
      recencyWeight(usage, now) +
      usefulnessWeight(usage),
  }
}

export interface Choice {
  /** Ids to invalidate, worst first. Never longer than `excess`. */
  readonly victims: ReadonlyArray<string>
  /** How many candidates the two hard protections took off the table. */
  readonly protectedCount: number
}

/**
 * Pick which memories a scope gives up.
 *
 * ⚠️ **`excess` can exceed what is prunable**, and the answer is then a SHORT list rather than a
 * reach into protected rows. A cap that cannot be met by forgetting the forgettable is a cap that is
 * too low for what the user has chosen to keep, and the honest behaviour is to stay over it.
 */
export const choose = (input: {
  readonly candidates: ReadonlyArray<Candidate>
  readonly usage: ReadonlyMap<string, Usage>
  readonly excess: number
  readonly now: number
}): Choice => {
  if (input.excess <= 0) return { victims: [], protectedCount: 0 }
  const scored = input.candidates.map((candidate) => ({
    candidate,
    scored: score(candidate, input.usage.get(candidate.id), input.now),
  }))
  const protectedCount = scored.filter((entry) => entry.scored.protectedFor !== undefined).length
  const victims = scored
    .filter((entry) => entry.scored.protectedFor === undefined)
    .sort(
      (a, b) =>
        a.scored.score - b.scored.score ||
        // 🔴 AGE ENTERS HERE AND NOWHERE ELSE. Two memories the ledger and the provenance cannot tell
        // apart are separated by which one is older, which is the whole of what the previous policy
        // had to work with.
        createdAt(a.candidate) - createdAt(b.candidate),
    )
    .slice(0, input.excess)
    .map((entry) => entry.candidate.id)
  return { victims, protectedCount }
}

/** Missing timestamps sort as "oldest", which is the safe direction: a row the engine cannot date is
 *  a row nothing is known about, and it should not outrank one that has a date and a record. */
const createdAt = (candidate: Candidate): number => {
  if (candidate.createdAt === undefined) return 0
  const parsed = Date.parse(candidate.createdAt)
  return Number.isNaN(parsed) ? 0 : parsed
}
