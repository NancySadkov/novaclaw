export * as SessionLocationRecovery from "./location-recovery"

import { and, eq, or, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import type { AbsolutePath } from "../schema"
import { SessionSchema } from "./schema"
import { SessionComponentTable, SessionTable } from "./sql"

type Db = Database.Interface["db"]

export const KIND = "missing_working_folder" as const

export const get = (db: Db, sessionID: SessionSchema.ID) =>
  db
    .select({ directory: SessionComponentTable.value })
    .from(SessionComponentTable)
    .where(
      and(
        eq(SessionComponentTable.session_id, sessionID),
        eq(SessionComponentTable.kind, KIND),
        eq(SessionComponentTable.component_id, ""),
      ),
    )
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.directory as AbsolutePath | undefined),
    )

export const record = (db: Db, sessionID: SessionSchema.ID, directory: AbsolutePath) => {
  const now = Date.now()
  return db
    .insert(SessionComponentTable)
    .values({
      session_id: sessionID,
      kind: KIND,
      component_id: "",
      schema_version: 1,
      lifetime: "entity",
      value: directory,
      time_created: now,
      time_updated: now,
    })
    .onConflictDoUpdate({
      target: [SessionComponentTable.session_id, SessionComponentTable.kind, SessionComponentTable.component_id],
      set: { value: directory, time_updated: now },
    })
    .run()
    .pipe(Effect.orDie, Effect.asVoid)
}

export const clear = (db: Db, sessionID: SessionSchema.ID) =>
  db
    .delete(SessionComponentTable)
    .where(
      and(
        eq(SessionComponentTable.session_id, sessionID),
        eq(SessionComponentTable.kind, KIND),
        eq(SessionComponentTable.component_id, ""),
      ),
    )
    .run()
    .pipe(Effect.orDie, Effect.asVoid)

/** Correlated predicate: current folder OR the folder automatic recovery moved this session out of. */
export const matchesDirectory = (directory: AbsolutePath) =>
  or(
    eq(SessionTable.directory, directory),
    sql<boolean>`exists (
    select 1 from ${SessionComponentTable}
    where ${SessionComponentTable.session_id} = ${SessionTable.id}
      and ${SessionComponentTable.kind} = ${KIND}
      and ${SessionComponentTable.component_id} = ''
      and json_extract(${SessionComponentTable.value}, '$') = ${directory}
  )`,
  )!
