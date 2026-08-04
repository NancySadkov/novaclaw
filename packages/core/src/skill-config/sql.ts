import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

// Config→SQLite step 4 (config-sqlite-plan): the instance-wide SKILL-CONFIG store. The config-borne
// `skills` entries (extra discovery sources: URLs or directory paths) live here, not in
// novaclaw.jsonc — one row per source string. Local paths are stored ABSOLUTE (the seed resolves a
// jsonc's relative/`~` entries against the declaring file's directory once, at import) so an
// instance-wide source means the same directory from every location. The `skill(s)/` directory
// walk under config dirs deliberately STAYS on the filesystem (locked decision D2).
export const SkillConfigTable = sqliteTable("skill_config", {
  source: text().primaryKey(),
  ...Timestamps,
})
