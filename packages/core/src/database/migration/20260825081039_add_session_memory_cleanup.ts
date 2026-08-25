import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260825081039_add_session_memory_cleanup",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_memory_cleanup\` (
          \`session_id\` text PRIMARY KEY,
          \`requested_at\` integer NOT NULL
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
