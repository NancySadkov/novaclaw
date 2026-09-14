import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/** Short-lived diagnostic prompts used only to estimate a server's reusable byte prefix. */
export const ModelPrefixCacheTable = sqliteTable(
  "model_prefix_cache",
  {
    id: text().primaryKey(),
    model: text().notNull(),
    prompt: text().notNull(),
    bytes: integer().notNull(),
    expiresAt: integer("expires_at").notNull(),
    timeCreated: integer("time_created").notNull(),
  },
  (table) => [index("model_prefix_cache_model_expires_idx").on(table.model, table.expiresAt)],
)
