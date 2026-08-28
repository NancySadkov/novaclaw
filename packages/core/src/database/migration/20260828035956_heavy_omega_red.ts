import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260828035956_heavy_omega_red",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`messenger_inbound\` (
          \`account_id\` text NOT NULL,
          \`chat_id\` text NOT NULL,
          \`message_id\` text NOT NULL,
          \`time_routed\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`messenger_inbound_pk\` PRIMARY KEY(\`account_id\`, \`chat_id\`, \`message_id\`)
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
