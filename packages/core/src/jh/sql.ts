import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"

// jh — persistence tables (jh.md §6b: the plan IS the state; the append-only log is its history). One
// jh_plan row per task (its serialized JhEngine.State minus artifacts/log), jh_artifact rows for the
// content-addressed produces, jh_log rows for the event log. Engine-internal — NOT the EventV2 vocab
// (D10). Kept in sync with the migration under database/migration/ (drizzle-kit generates both).

export const JhPlanTable = sqliteTable(
  "jh_plan",
  {
    id: text("id").primaryKey(),
    goal: text("goal").notNull(),
    status: text("status").notNull(), // "running" | "done" | "blocked"
    state: text("state", { mode: "json" }).$type<unknown>().notNull(), // serialized State minus artifacts/log
    timeCreated: integer("time_created").notNull(),
    timeUpdated: integer("time_updated").notNull(),
  },
  // `store.ts`'s `purgeExpired` runs `SELECT id FROM jh_plan WHERE time_updated < ?` once per Strict
  // drain — the hot path INTO every Strict turn — and the only index on this table was the primary
  // key's auto-index on `id`, which that predicate cannot use. So the retention sweep read every plan
  // row in the table on every turn, and the cost grew with the very table the sweep exists to bound.
  //
  // Two columns, not one, deliberately: the query projects `id` and nothing else, so `(time_updated,
  // id)` is COVERING and the plan becomes index-only (`SEARCH … USING COVERING INDEX`, pinned by an
  // EXPLAIN QUERY PLAN assertion in store.test.ts with a drop-the-index negative control). In the
  // steady state — nothing expired — the matching rows sit at the low end of the index, so the sweep
  // seeks to the first leaf and stops instead of touching a single table page.
  (t) => [index("jh_plan_time_updated_id_idx").on(t.timeUpdated, t.id)],
)

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
