import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821070238_add_session_compaction_request",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_compaction_request\` (
          \`session_id\` text PRIMARY KEY,
          \`requested_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
