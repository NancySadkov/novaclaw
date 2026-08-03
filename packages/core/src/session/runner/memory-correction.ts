export * as MemoryCorrection from "./memory-correction"

import { Effect } from "effect"
import fs from "node:fs"
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

/** Invalidate recalled facts which led a failed read to a path that is now confirmed absent.
 * Invalidation is bitemporal: the old claim remains in history/audit views but is excluded from
 * future recall. Memory is best-effort, so an unavailable graph never turns a recoverable read error
 * into a failed agent step. */
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
  const stale = SessionRecall.memoriesMentioningPath(input.recalled, [input.requested, input.resolved]).filter(
    (hit) => hit.source === "auto-extract",
  )
  const unique = [...new Map(stale.map((hit) => [hit.id, hit])).values()]
  return Effect.forEach(
    unique,
    (hit) =>
      input.memory.invalidate(hit.id).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      ),
    { concurrency: 4 },
  ).pipe(Effect.map((results) => results.filter(Boolean).length))
}
