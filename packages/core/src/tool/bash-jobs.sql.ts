import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"

// 1H durable jobs (small-tails T6): the persistent shadow of BashJobs' in-memory state. The
// output column is bounded by the tool's own byte cap, so rows stay small; `running` rows left
// behind by a dead process are marked `interrupted` at the next process boot (recovery is
// process-scoped — a LOCATION boot must never touch another live location's rows).
export const BashJobTable = sqliteTable(
  "bash_job",
  {
    id: text().primaryKey(),
    owner: text().notNull(),
    command: text().notNull(),
    status: text().$type<"running" | "done" | "interrupted">().notNull(),
    exit: integer(),
    output: text().notNull().default(""),
    truncated: integer({ mode: "boolean" }).notNull().default(false),
    time_started: integer().notNull(),
    time_done: integer(),
  },
  (table) => [index("bash_job_owner_idx").on(table.owner)],
)
