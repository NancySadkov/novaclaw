import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260808122357_add_session_auto_grant",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_auto_grant\` (
          \`session_id\` text PRIMARY KEY,
          \`mode\` text NOT NULL,
          \`justification\` text NOT NULL,
          \`at\` integer NOT NULL,
          CONSTRAINT \`fk_session_auto_grant_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
