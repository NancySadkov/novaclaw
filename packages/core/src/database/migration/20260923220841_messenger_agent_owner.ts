import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260923220841_messenger_agent_owner",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`CREATE TABLE \`messenger_account_owned\` (
        \`id\` text PRIMARY KEY,
        \`agent_id\` text NOT NULL,
        \`driver_id\` text NOT NULL,
        \`label\` text NOT NULL,
        \`enabled\` integer NOT NULL,
        \`credential_id\` text,
        \`settings\` text NOT NULL,
        \`time_created\` integer NOT NULL,
        \`time_updated\` integer NOT NULL
      );`)
      yield* tx.run(`INSERT INTO \`messenger_account_owned\` (
        \`id\`, \`agent_id\`, \`driver_id\`, \`label\`, \`enabled\`, \`credential_id\`,
        \`settings\`, \`time_created\`, \`time_updated\`
      ) SELECT \`id\`, 'nova', \`driver_id\`, \`label\`, \`enabled\`, \`credential_id\`,
        \`settings\`, \`time_created\`, \`time_updated\` FROM \`messenger_account\`;`)
      yield* tx.run(`DROP TABLE \`messenger_account\`;`)
      yield* tx.run(`ALTER TABLE \`messenger_account_owned\` RENAME TO \`messenger_account\`;`)
    })
  },
} satisfies DatabaseMigration.Migration
