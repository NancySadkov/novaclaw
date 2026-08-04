import { index, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// T1's durable, mechanically regenerated catalogue. `scope` is the Location directory because
// project MCP/config overlays can expose different tools under the same registered name. The FTS5
// projection is intentionally created lazily by ToolCatalogueStore rather than in the boot migration:
// search is an optional acceleration edge and must never turn a missing SQLite capability into a
// failed instance start.
export const ToolCatalogueTable = sqliteTable(
  "tool_catalogue",
  {
    scope: text().notNull(),
    name: text().notNull(),
    server: text().notNull(),
    description: text().notNull(),
    argument_names: text().notNull(),
    arguments: text({ mode: "json" })
      .$type<ReadonlyArray<{ readonly name: string; readonly description?: string }>>()
      .notNull(),
    input_schema: text({ mode: "json" }).$type<unknown>().notNull(),
    // Index-only text. It is deliberately absent from the manifest and every prompt renderer.
    keywords: text().notNull().default(""),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.scope, table.name] }),
    index("tool_catalogue_scope_server_idx").on(table.scope, table.server),
  ],
)
