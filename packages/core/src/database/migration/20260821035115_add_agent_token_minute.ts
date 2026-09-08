import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260821035115_add_agent_token_minute",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`agent_token_minute\` (
          \`agent\` text NOT NULL,
          \`minute\` integer NOT NULL,
          \`generated\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`agent_token_minute_pk\` PRIMARY KEY(\`agent\`, \`minute\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
