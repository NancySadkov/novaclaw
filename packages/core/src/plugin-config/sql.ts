import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Config→SQLite step 5 (config-sqlite-plan): the instance-wide EXTERNAL-PLUGIN store. The
// config-borne `plugins` specs live here, not in novaclaw.jsonc — one row per package (last
// write wins on options). Local specs are stored ABSOLUTE (the seed resolves a jsonc's
// `./`/`file://` entries against the declaring file's directory once, at import) so an
// instance-wide spec means the same module from every location; bare npm package names pass
// through. The `{plugin,plugins}/*.{ts,js}` walk under config dirs deliberately STAYS on the
// filesystem (the D2 analog — user-dropped plugin files, not settings).
export const PluginConfigTable = sqliteTable("plugin_config", {
  package: text().primaryKey(),
  options: text({ mode: "json" }).$type<Record<string, unknown>>(),
  ...Timestamps,
})
