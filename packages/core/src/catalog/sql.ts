import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { ProviderV2 } from "../provider"
import type { ConfigProvider } from "../config/provider"

// The instance-wide catalog store (settings-in-SQLite migration). Providers/models live here, not in
// novaclaw.jsonc — see the memory `settings-in-sqlite-jsonc-export-only` + todo.md "Config → SQLite
// migration". One row per provider; `layers` is the ordered list of `ConfigProvider.Info` fragments for
// that provider (the same shape novaclaw.jsonc held and the settings UI edits). Applying the layers in
// order reproduces the old multi-file config merge (later fragments override/extend earlier ones); a
// single-file import (the common case) has exactly one layer.
export const CatalogProviderTable = sqliteTable("catalog_provider", {
  id: text().$type<ProviderV2.ID>().primaryKey(),
  layers: text({ mode: "json" }).$type<ConfigProvider.Info[]>().notNull(),
  ...Timestamps,
})

// Instance-wide catalog-level settings (currently just the default model, keyed "default_model" with a
// `providerID/modelID` string value). A key/value table so future catalog settings need no new migration.
export const CatalogSettingTable = sqliteTable("catalog_setting", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).$type<string>().notNull(),
  ...Timestamps,
})
