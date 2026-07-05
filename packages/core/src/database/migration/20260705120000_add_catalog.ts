import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// Settings → SQLite migration, step 1 (catalog): the instance-wide provider/model store. One row per
// provider (its models nested in the `config` JSON blob), plus a key/value `catalog_setting` table for
// catalog-level settings (default model). Mirrors `catalog/sql.ts` — keep the two in sync.
export default {
  id: "20260705120000_add_catalog",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`catalog_provider\` (
          \`id\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`catalog_setting\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
