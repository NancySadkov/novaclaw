import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { WorkspaceV2 } from "../workspace"

// T2 (notes/entities.md): workspaces are scoped by the rename-stable `origin` hash — a derived
// substrate attribute of the repo they manage, not a foreign key into a project entity.
export const WorkspaceTable = sqliteTable("workspace", {
  id: text().$type<WorkspaceV2.ID>().primaryKey(),
  type: text().notNull(),
  name: text().notNull().default(""),
  branch: text(),
  directory: text(),
  extra: text({ mode: "json" }),
  origin: text().notNull(),
  time_used: integer()
    .notNull()
    .$default(() => Date.now()),
})
