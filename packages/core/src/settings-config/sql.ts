import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Config→SQLite step 6 (config-sqlite-plan): the instance-wide RUNTIME-SETTINGS store — the
// scalar/object settings the direct `Config.latest()` readers consume (shell, snapshots,
// persona, quality, affective, introspection, user_profile, …). One row per top-level config
// key; `value` is the whole JSON value (latest() semantics are whole-value replace per key, so
// layers are unnecessary — last write wins). The authoritative key list is
// `SettingsConfigSeed.SETTINGS_KEYS`.
export const RuntimeSettingTable = sqliteTable("runtime_setting", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).notNull(),
  ...Timestamps,
})
