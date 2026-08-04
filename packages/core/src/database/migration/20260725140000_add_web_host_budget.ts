import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// The web traffic governor's per-host budget (core/web/fetch-pace.ts + web/governor.ts). Durable so a
// crash-looping agent cannot reset its own daily cap by restarting. Mirrors web/budget.sql.ts and the
// web_host_budget block in schema.gen.ts — keep the three in sync.
export default {
  id: "20260725140000_add_web_host_budget",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`web_host_budget\` (
          \`host\` text PRIMARY KEY,
          \`day\` text NOT NULL,
          \`count\` integer DEFAULT 0 NOT NULL,
          \`tokens\` real DEFAULT 0 NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
