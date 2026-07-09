import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// jh — persistence tables (jh.md §6b: the plan IS the state; the append-only log is its history). One
// jh_plan row per task (its serialized JhEngine.State minus artifacts/log), jh_artifact rows for the
// content-addressed produces, jh_log rows for the event log. Engine-internal — NOT the EventV2 vocab
// (D10). Kept in sync with the migration under database/migration/ (drizzle-kit generates both).

export const JhPlanTable = sqliteTable("jh_plan", {
  id: text("id").primaryKey(),
  goal: text("goal").notNull(),
  status: text("status").notNull(), // "running" | "done" | "blocked"
  state: text("state", { mode: "json" }).$type<unknown>().notNull(), // serialized State minus artifacts/log
  timeCreated: integer("time_created").notNull(),
  timeUpdated: integer("time_updated").notNull(),
})

export const JhArtifactTable = sqliteTable(
  "jh_artifact",
  {
    planID: text("plan_id").notNull(),
    artifactID: text("artifact_id").notNull(),
    type: text("type").notNull(),
    hash: text("hash").notNull(),
    content: text("content").notNull(),
  },
  (t) => [primaryKey({ columns: [t.planID, t.artifactID] })],
)

export const JhLogTable = sqliteTable(
  "jh_log",
  {
    planID: text("plan_id").notNull(),
    seq: integer("seq").notNull(),
    entry: text("entry", { mode: "json" }).$type<unknown>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.planID, t.seq] })],
)
