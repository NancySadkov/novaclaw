import { integer, sqliteTable, text, index } from "drizzle-orm/sqlite-core"
import type { WorkProject } from "@novaclaw/schema/work-project"

export const WorkProjectTable = sqliteTable("work_project", {
  id: text().primaryKey(),
  name: text().notNull(),
  objective: text().notNull(),
  directory: text(),
  recipe: text({ mode: "json" }).$type<WorkProject.Recipe>(),
  phases: text({ mode: "json" }).$type<readonly WorkProject.Phase[]>().notNull(),
  paused: integer({ mode: "boolean" }).notNull().default(false),
  revision: integer().notNull().default(1),
})

export const ProjectOfficerTable = sqliteTable(
  "project_officer",
  {
    agent: text().primaryKey(),
    project_id: text()
      .notNull()
      .references(() => WorkProjectTable.id, { onDelete: "cascade" }),
  },
  (table) => [index("project_officer_project_idx").on(table.project_id)],
)

export const ProjectNoticeTable = sqliteTable("project_notice", {
  agent: text().primaryKey(),
  id: text().notNull(),
  text: text().notNull(),
  delivery: text().$type<"queue" | "steer">().notNull().default("steer"),
})
