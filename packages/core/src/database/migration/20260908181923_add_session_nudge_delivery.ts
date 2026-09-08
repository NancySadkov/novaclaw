import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260908181923_add_session_nudge_delivery",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_nudge_delivery\` (
          \`session_id\` text NOT NULL,
          \`nudge_id\` text NOT NULL,
          \`occurrence\` text NOT NULL,
          \`fired_at\` integer NOT NULL,
          CONSTRAINT \`session_nudge_delivery_pk\` PRIMARY KEY(\`session_id\`, \`nudge_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
