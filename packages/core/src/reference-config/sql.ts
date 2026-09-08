import { sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { ConfigReference } from "../config/reference"

// Config→SQLite step 4 (config-sqlite-plan): the instance-wide REFERENCE-CONFIG store. Config-borne
// reference aliases live here, not in novaclaw.jsonc — one row per alias; `layers` is the ordered
// list of `ConfigReference.Entry` fragments (last wins, the historical per-document merge). Local
// entries are stored NORMALIZED to the `{ path }` object form with an ABSOLUTE path (the seed
// resolves a jsonc's relative/`~` paths against the declaring file's directory once, at import) —
// a bare absolute-path STRING would misclassify as a git remote on Windows (`C:/…` fails the
// leading `./~` local test).
export const ReferenceConfigTable = sqliteTable("reference_config", {
  name: text().primaryKey(),
  layers: text({ mode: "json" }).$type<ConfigReference.Entry[]>().notNull(),
  ...Timestamps,
})
