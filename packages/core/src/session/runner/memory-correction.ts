export * as MemoryCorrection from "./memory-correction"

import { Effect } from "effect"
import fs from "node:fs"
import * as MemoryAccess from "../../kb-graph/memory-access"
import type { MemoryClient } from "../../kb-graph/memory-client"
import { SessionRecall } from "./recall"

/** A read error is correction evidence only when the target is absent now. The read tool deliberately
 * returns one calm generic error for many causes, so parsing its text would erase good memories after
 * permission denials, binary-file refusals, size limits, or transient I/O failures. */
export const isConfirmedMissingPath = (target: string): boolean => {
  try {
    fs.statSync(target)
    return false
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    return code === "ENOENT" || code === "ENOTDIR"
  }
}

/**
 * THE EVIDENCE MOVED — flag every claim that CITED the missing path, by traversal.
 *
 * 🔴 This is the deterministic half, and it is deliberately separate from the text-matching pass
 * below. A claim reached this way is one whose stored `supported_by` edge names the file, so the set
 * is a fact about the graph rather than a judgement about prose — and the outcome is `needs_review`,
 * not invalidation, because a file being renamed is evidence the CITATION is stale and no evidence at
 * all that the claim is false.
 *
 * ⚠️ `system()` access: the instance correcting its own bookkeeping with no session asking, spelled
 * rather than reached by omitting an argument.
 */
export const reviewMovedEvidence = (input: {
  readonly memory: MemoryClient.Interface
  readonly requested: string
  readonly resolved: string
}): Effect.Effect<number> => {
  if (!isConfirmedMissingPath(input.resolved)) return Effect.succeed(0)
  // BOTH spellings, because a claim cites whichever the writer had: the path as the user typed it, or
  // the resolved absolute one. They are deduplicated so an identical pair is not counted twice.
  const locators = [...new Set([input.requested, input.resolved].map((l) => l.trim()).filter(Boolean))]
  return Effect.forEach(
    locators,
    (locator) => input.memory.reviewEvidence(locator, MemoryAccess.system()).pipe(Effect.orElseSucceed(() => 0)),
    { concurrency: 2 },
  ).pipe(Effect.map((counts) => counts.reduce((sum, n) => sum + n, 0)))
}

/** Invalidate recalled facts which led a failed read to a path that is now confirmed absent.
 * Invalidation is bitemporal: the old claim remains in history/audit views but is excluded from
 * future recall. Memory is best-effort, so an unavailable graph never turns a recoverable read error
 * into a failed agent step.
 *
 * ⚠️ **This is the LEGACY half and it stays bounded to what it always owned**: auto-extracted prose
 * with no stored evidence, matched by exact path mention. A governed claim is handled by
 * `reviewMovedEvidence` instead — it has a source edge, so guessing from its wording would be a worse
 * answer than the one the graph already holds. */
export const correctMissingRead = (input: {
  readonly memory: MemoryClient.Interface
  readonly recalled: ReadonlyArray<MemoryClient.SearchHit>
  readonly requested: string
  readonly resolved: string
}): Effect.Effect<number> => {
  if (!isConfirmedMissingPath(input.resolved)) return Effect.succeed(0)
  // Automatic correction owns only automatic memories. A user-curated memory may be historical,
  // instructional, or intentionally phrased in a way filesystem evidence cannot interpret; Nova
  // must leave that deliberate record for the user to edit or forget explicitly.
  const stale = SessionRecall.memoriesMentioningPath(input.recalled, [input.requested, input.resolved])
    // A CLAIM is governed: it either cites this evidence, in which case `reviewMovedEvidence` has
    // already flagged it for review, or it does not, in which case merely quoting a path is not
    // grounds to retire it. Either way the guess is the wrong instrument.
    .filter((hit) => hit.kind !== "claim")
    .filter(
      // ⚠️ `consolidated` counts too. A consolidated twin is an auto-extracted fact that outlived its
      // chat, so it is exactly as automatic — and exactly as correctable — as the original. Matching
      // only `auto-extract` would have made a promoted claim permanently un-correctable the moment it
      // was promoted, which is the wrong half to protect.
      (hit) => hit.source === "auto-extract" || hit.source === "consolidated",
    )
  const unique = [...new Map(stale.map((hit) => [hit.id, hit])).values()]
  return Effect.forEach(
    unique,
    (hit) =>
      // ⚠️ SYSTEM access: this runs on the instance's own behalf, correcting facts it extracted
      // itself, with no session asking. Spelled rather than reached by omitting an argument — that
      // omission is what NC-SEC-016 was.
      input.memory.invalidate(hit.id, MemoryAccess.system()).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((results) => results.filter(Boolean).length))
}
