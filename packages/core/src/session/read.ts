export * as SessionRead from "./read"

// The NATIVE deps-taking session read seam (rule §0.7.1 — SessionMessageRead's sibling): list/get
// over a plain `db` handle returning native `SessionSchema.Info`, so CLI commands and other
// service-less callers never need the full SessionV2.Service graph. The SERVICE's list delegates
// here — exactly one implementation of the filter surface. V1-nuke slice A: this replaces
// the session read seam for every consumer (CLI, middleware, service list).

import { and, asc, desc, eq, gt, isNull, like, lt, or, type SQL } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { SessionV2 } from "../session"
import { fromRow } from "./info"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"

type Db = Database.Interface["db"]

export const list = (db: Db, input: SessionV2.ListInput = {}): Effect.Effect<SessionSchema.Info[]> =>
  Effect.gen(function* () {
    const direction = input.anchor?.direction ?? "next"
    const requestedOrder = input.order ?? "desc"
    const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
    const sortColumn = SessionTable.time_created
    const conditions: SQL[] = []
    if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
    if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
    // "Under a root": the directory IS the root, or sits below it with an explicit separator
    // boundary (never the sibling `C:\repo2` when under=`C:\repo`) — both separator styles.
    if ("under" in input) {
      const top = "\uffff"
      conditions.push(
        or(
          eq(SessionTable.directory, input.under),
          and(gt(SessionTable.directory, input.under + "\\"), lt(SessionTable.directory, input.under + "\\" + top)),
          and(gt(SessionTable.directory, input.under + "/"), lt(SessionTable.directory, input.under + "/" + top)),
        )!,
      )
    }
    if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
    if (input.roots) conditions.push(isNull(SessionTable.parent_id))
    if (input.anchor) {
      conditions.push(
        order === "asc"
          ? or(
              gt(sortColumn, input.anchor.time),
              and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
            )!
          : or(
              lt(sortColumn, input.anchor.time),
              and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
            )!,
      )
    }
    const query = db
      .select()
      .from(SessionTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(
        order === "asc" ? asc(sortColumn) : desc(sortColumn),
        order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
      )
    const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(Effect.orDie)
    return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
  })

export const get = (db: Db, sessionID: SessionSchema.ID): Effect.Effect<SessionSchema.Info | undefined> =>
  db
    .select()
    .from(SessionTable)
    .where(eq(SessionTable.id, sessionID))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => (row ? fromRow(row) : undefined)),
    )
