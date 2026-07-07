export * as SessionV1Read from "./v1-read"

import { Effect } from "effect"
import { asc, eq } from "drizzle-orm"
import type { Database } from "../database/database"
import { SessionV1 } from "../v1/session"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { v1InfoFromRow } from "./info"

/**
 * Row-faithful session-level reads in the LEGACY wire shape (`SessionV1.SessionInfo`) — the
 * vocabulary the HTTP session API and the session-level events (`session.created/updated/
 * deleted`, kept by F1g) share, so the client sees ONE shape from both. Deliberately NOT a
 * lossy V2→V1 bridge: it reads the raw row exactly like the V1 `Session.Service` it replaces
 * (F1c read-sweep). Retires only with a wholesale session-API wire migration.
 */

export const get = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<SessionV1.SessionInfo | undefined> =>
  db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? v1InfoFromRow(row) : undefined)),
    )

export const children = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<SessionV1.SessionInfo[]> =>
  db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.parent_id, sessionID))
    .orderBy(asc(SessionTable.time_created))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.map(v1InfoFromRow)),
    )
