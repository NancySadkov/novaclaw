import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260722135926_add_messenger",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`messenger_account\` (
          \`id\` text PRIMARY KEY,
          \`driver_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`enabled\` integer NOT NULL,
          \`credential_id\` text,
          \`settings\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messenger_binding\` (
          \`id\` text PRIMARY KEY,
          \`account_id\` text NOT NULL,
          \`chat_id\` text NOT NULL,
          \`session_id\` text NOT NULL,
          \`trust\` text NOT NULL,
          \`status\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messenger_chat\` (
          \`account_id\` text NOT NULL,
          \`chat_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`title\` text NOT NULL,
          \`last_seen\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`messenger_chat_pk\` PRIMARY KEY(\`account_id\`, \`chat_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messenger_contact\` (
          \`account_id\` text NOT NULL,
          \`sender_id\` text NOT NULL,
          \`name\` text NOT NULL,
          \`trust\` text NOT NULL,
          \`paired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`messenger_contact_pk\` PRIMARY KEY(\`account_id\`, \`sender_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`messenger_cursor\` (
          \`account_id\` text PRIMARY KEY,
          \`cursor\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`messenger_binding_chat_idx\` ON \`messenger_binding\` (\`account_id\`,\`chat_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`messenger_binding_session_idx\` ON \`messenger_binding\` (\`session_id\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
