import { sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { PermissionSaved } from "./saved"

// T2 (notes/entities.md): saved verdicts are scoped by the rename-stable `origin` hash — a
// derived substrate attribute of the location, not a foreign key into a project entity.
export const PermissionTable = sqliteTable(
  "permission",
  {
    id: text().$type<PermissionSaved.ID>().primaryKey(),
    origin: text().notNull(),
    action: text().notNull(),
    resource: text().notNull(),
    effect: text().$type<"allow" | "deny">(),
    ...Timestamps,
  },
  (table) => [uniqueIndex("permission_origin_action_resource_idx").on(table.origin, table.action, table.resource)],
)
