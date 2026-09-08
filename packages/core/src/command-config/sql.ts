import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { ConfigCommand } from "../config/command"

// Config→SQLite step 3 (config-sqlite-plan): the instance-wide COMMAND-CONFIG store. Config-file-borne
// command definitions live here, not in novaclaw.jsonc — one row per command name; `layers` is the
// ordered list of `ConfigCommand.Info` fragments (the same shape a jsonc `commands.<name>` block held).
// Applying the layers in order reproduces the old multi-file merge. Markdown commands
// (`{command,commands}/**/*.md`) deliberately STAY on the filesystem (locked decision D2).
export const CommandConfigTable = sqliteTable("command_config", {
  name: text().primaryKey(),
  layers: text({ mode: "json" }).$type<ConfigCommand.Info[]>().notNull(),
  ...Timestamps,
})
