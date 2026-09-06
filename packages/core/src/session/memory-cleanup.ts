export * as SessionMemoryCleanup from "./memory-cleanup"

import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { MemoryClient } from "../kb-graph/memory-client"
import type { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionMemoryCleanupTable } from "./memory-cleanup.sql"

/**
 * WHAT DELETING A CHAT OWES THE MEMORY STORE.
 *
 * 🔴 The defect (NC-SEC-019, revalidated at HEAD 2026-08-25 rather than trusted). The confirmation
 * says *"The whole conversation and its history are removed permanently"*. `removeSessionRecord`
 * enumerates its cleanup — interrupt, scheduler eviction, JH records, recursive children, the session
 * row and its FK-backed messages/parts/todos/tags, and the aggregate event log — and never touches the
 * graph store. Its dependency shape has no memory service at all. So every memory the user explicitly
 * wrote with `scope: "session"` survives on disk under `session:<deleted-id>`: unreachable through
 * ordinary recall, still enumerable through the Memory app, and still personal data the product told
 * them was gone.
 *
 * 🔴 **Why this is a tombstone and not one more line in the delete.** The memory engine opens lazily
 * and can be down, and it is a SEPARATE store with no shared transaction. A best-effort call inside
 * the deletion turns "the graph was unavailable for ten seconds" into "those memories are never going
 * away", with a success already reported to the user — the exact shape of promise this file exists to
 * stop breaking. The row is written first and survives restart, so an unavailable graph delays the
 * cleanup instead of losing it.
 *
 * ⚠️ **The guard is what makes the ordering safe.** The tombstone is written BEFORE the session is
 * deleted (there is no transaction spanning both stores, so something must go first), which means a
 * crash in between can leave a tombstone for a session that still exists. Clearing a LIVE chat's
 * memories is far worse than leaving a dead one's behind, so the sweeper re-checks: a session that is
 * still present retracts its own tombstone. Ordering therefore cannot cause data loss in either
 * direction, and that is the argument — not the narrowness of the window.
 */

/** Mark a session's memories for removal. Idempotent — deleting twice is not an error. */
export const request = (db: Database.Interface["db"], sessionID: SessionSchema.ID, now = Date.now()) =>
  db
    .insert(SessionMemoryCleanupTable)
    .values({ session_id: sessionID, requested_at: now })
    .onConflictDoNothing({ target: SessionMemoryCleanupTable.session_id })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

/** How many tombstones are outstanding — the number a diagnostic surface should be able to show. */
export const pending = (db: Database.Interface["db"]) =>
  db.select().from(SessionMemoryCleanupTable).all().pipe(Effect.orDie)

export interface SweepResult {
  /** Sessions whose memories were cleared. */
  readonly cleared: number
  /** Tombstones retracted because the session turned out to still exist. */
  readonly retracted: number
  /** Tombstones kept for a later attempt — the graph could not be reached. */
  readonly deferred: number
}

/**
 * Drain the outstanding tombstones.
 *
 * Safe to call repeatedly and from more than one place: every step is idempotent, and a row is only
 * removed once the memories it names are actually gone.
 */
export const sweep = (
  db: Database.Interface["db"],
  memory: MemoryClient.Interface,
  worldMemory?: MemoryClient.Interface,
): Effect.Effect<SweepResult> =>
  Effect.gen(function* () {
    const rows = yield* pending(db)
    let cleared = 0
    let retracted = 0
    let deferred = 0
    for (const row of rows) {
      const live = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.id, row.session_id))
        .get()
        .pipe(Effect.orDie)
      if (live) {
        // The deletion never completed. Retract rather than clear — see the ordering note above.
        yield* forget(db, row.session_id)
        retracted += 1
        continue
      }
      // ⚠️ `clearScope` is addressed BY SCOPE, so it carries no `MemoryAccess` — the scope string is
      // the authority. That is the one id-based op NC-SEC-016 did not touch, and it is why: there is
      // no id here to be wrong about.
      // A deleted chat may have automatic memories in the world graph and explicit session memories
      // in the KB graph. Discharge both tombstone targets before removing the durable request; one
      // unavailable graph must not make the other graph's cleanup silently disappear.
      const stores = worldMemory === undefined ? [memory] : [memory, worldMemory]
      let done = true
      for (const store of stores) {
        const cleared = yield* store.clearScope(`session:${row.session_id}`).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        )
        done = done && cleared
      }
      if (!done) {
        deferred += 1
        continue
      }
      yield* forget(db, row.session_id)
      cleared += 1
    }
    return { cleared, retracted, deferred }
  })

const forget = (db: Database.Interface["db"], sessionID: SessionSchema.ID) =>
  db
    .delete(SessionMemoryCleanupTable)
    .where(eq(SessionMemoryCleanupTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
