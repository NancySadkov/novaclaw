export * as RosterChat from "./roster-chat"

import { and, desc, eq, isNull } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionTable } from "./sql"

type Db = Database.Interface["db"]

// WHICH chat belongs to a colleague, server-side (AGENTS.md — the structural metaphor).
//
// The roster UI answers this in `app/src/apps/roster-live.ts` for what it draws; this is the same
// question asked by the kernel, for the colleague tool — one colleague, one chat, so a message sent
// to a name has exactly one place to land.
//
// ⚠️ The two implementations agree by RULE, not by sharing code: the UI folds a list it already
// holds, this one asks SQL. The rules are short enough to state and both are tested — a shared
// module across the wire boundary would cost more than it saves.

export interface Chat {
  readonly id: string
  readonly title: string
  /**
   * Where this chat actually runs.
   *
   * ⚠️ NOT the colleague's configured folder — the two diverge the moment it is reassigned, because
   * the chat stays where it was created (`agent/workspace.ts`). A caller that has to tell this chat
   * something true about its own root can get it from here and nowhere else.
   */
  readonly directory: string
}

/**
 * A colleague's one live chat, or `undefined` when it has none yet.
 *
 * ROOT sessions only: the nameless staff an officer spawns inherit its agent id through the config
 * walk, so a child would otherwise look exactly like a second chat for the same colleague — and a
 * message meant for the officer would land in a sub-task that ends when its work does.
 *
 * ARCHIVED sessions never win: "Clear chat" archives the old conversation, and handing a colleague
 * back the chat the user just cleared is the most confusing thing this lookup could do.
 */
export const chatFor = (db: Db, agentID: string) =>
  db
    // ⚠️ `directory` rides along because a caller that has to tell this chat something TRUE about
    // where it runs cannot get that from anywhere else — the colleague's configured folder and the
    // chat's actual root diverge the moment it is reassigned (`agent/workspace.ts`).
    .select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory })
    .from(SessionTable)
    .where(
      and(
        eq(SessionTable.agent, agentID),
        // Drizzle's `eq` refuses a literal against a branded column, and the brand is right — an
        // empty string is not a session id. `isNull` alone is the honest predicate: a root session
        // has no parent, and a row storing "" would be a defect upstream rather than a case to match.
        isNull(SessionTable.parent_id),
        isNull(SessionTable.time_archived),
      ),
    )
    .orderBy(desc(SessionTable.time_updated))
    .limit(1)
    .all()
    .pipe(
      Effect.map((rows): Chat | undefined => rows[0]),
      Effect.orDie,
    )

/**
 * EVERY live root chat of a colleague, newest first — the set `chatFor` picks its one answer from.
 *
 * Retirement needs the whole set, not the newest: a colleague accumulates roots across "Clear chat",
 * and one left live is a transcript the next holder of that id would open into.
 */
export const liveChatsFor = (db: Db, agentID: string) =>
  db
    .select({ id: SessionTable.id, title: SessionTable.title, directory: SessionTable.directory })
    .from(SessionTable)
    .where(
      and(eq(SessionTable.agent, agentID), isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)),
    )
    .orderBy(desc(SessionTable.time_updated))
    .all()
    .pipe(Effect.map((rows): ReadonlyArray<Chat> => rows), Effect.orDie)
