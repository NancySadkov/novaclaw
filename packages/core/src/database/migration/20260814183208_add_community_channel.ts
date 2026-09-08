import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260814183208_add_community_channel",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`community_channel\` (
          \`name\` text PRIMARY KEY,
          \`muted\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_message\` (
          \`id\` text PRIMARY KEY,
          \`channel\` text NOT NULL,
          \`author\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`received_at\` integer NOT NULL,
          \`body\` text NOT NULL,
          \`signature\` text NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`community_message_channel_idx\` ON \`community_message\` (\`channel\`,\`received_at\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
