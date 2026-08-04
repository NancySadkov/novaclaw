import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { ConfigAgent } from "../config/agent"

// Config→SQLite step 2 (config-sqlite-plan): the instance-wide AGENT-CONFIG store. Config-file-borne
// agent definitions live here, not in novaclaw.jsonc — one row per agent name; `layers` is the ordered
// list of `ConfigAgent.Info` fragments (the same shape a jsonc `agents.<name>` block held). Applying
// the layers in order reproduces the old multi-file merge (later fragments override/extend earlier
// ones). Markdown agents (`{agent,agents,mode,modes}/**/*.md`) deliberately STAY on the filesystem
// (locked decision D2 — they are user-editable documents, not settings).
export const AgentConfigTable = sqliteTable("agent_config", {
  name: text().primaryKey(),
  layers: text({ mode: "json" }).$type<ConfigAgent.Info[]>().notNull(),
  ...Timestamps,
})

// Instance-wide agent-level settings (currently just the default agent, keyed "default_agent").
// A key/value table so future agent settings need no new migration (CatalogSettingTable shape).
export const AgentSettingTable = sqliteTable("agent_setting", {
  key: text().primaryKey(),
  value: text({ mode: "json" }).$type<string>().notNull(),
  ...Timestamps,
})
