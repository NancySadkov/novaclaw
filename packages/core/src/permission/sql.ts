import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { PermissionSaved } from "./saved"
import type { PermissionV2 } from "../permission"

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

/** A consent card is kernel state, not UI state. The deferred waiting in a live worker cannot be
 * persisted, so a recovered row may instead carry a one-shot verdict which the retried tool consumes
 * before it reaches its side effect. `origin` keeps location-scoped permission services isolated. */
export const PermissionPendingTable = sqliteTable(
  "permission_pending",
  {
    id: text().$type<PermissionV2.ID>().primaryKey(),
    origin: text().notNull(),
    session_id: text().notNull(),
    request: text().notNull(),
    agent: text(),
    awaited: integer({ mode: "boolean" }).notNull(),
    resolution: text().$type<"allow" | "deny">(),
    feedback: text(),
    ...Timestamps,
  },
  (table) => [index("permission_pending_origin_session_idx").on(table.origin, table.session_id)],
)
