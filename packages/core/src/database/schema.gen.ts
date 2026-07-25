import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`workspace\` (
          \`id\` text PRIMARY KEY,
          \`type\` text NOT NULL,
          \`name\` text DEFAULT '' NOT NULL,
          \`branch\` text,
          \`directory\` text,
          \`extra\` text,
          \`origin\` text NOT NULL,
          \`time_used\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`data_migration\` (
          \`name\` text PRIMARY KEY,
          \`time_completed\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`bash_job\` (
          \`id\` text PRIMARY KEY,
          \`owner\` text NOT NULL,
          \`command\` text NOT NULL,
          \`status\` text NOT NULL,
          \`exit\` integer,
          \`output\` text DEFAULT '' NOT NULL,
          \`truncated\` integer DEFAULT false NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_done\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`calendar_schedule\` (
          \`id\` text PRIMARY KEY,
          \`title\` text DEFAULT '' NOT NULL,
          \`recurrence_json\` text NOT NULL,
          \`tz_offset_min\` integer DEFAULT 0 NOT NULL,
          \`prompt\` text NOT NULL,
          \`agent\` text,
          \`model\` text,
          \`location_json\` text,
          \`enabled\` integer DEFAULT true NOT NULL,
          \`next_fire_at\` integer,
          \`last_fired_at\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`permission_mode\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`web_host_budget\` (
          \`host\` text PRIMARY KEY,
          \`day\` text NOT NULL,
          \`count\` integer DEFAULT 0 NOT NULL,
          \`tokens\` real DEFAULT 0 NOT NULL,
          \`updated_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`calendar_fire\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`occurrence_millis\` integer NOT NULL,
          \`fired_at\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account_state\` (
          \`id\` integer PRIMARY KEY,
          \`active_account_id\` text,
          \`active_org_id\` text,
          CONSTRAINT \`fk_account_state_active_account_id_account_id_fk\` FOREIGN KEY (\`active_account_id\`) REFERENCES \`account\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`account\` (
          \`id\` text PRIMARY KEY,
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`control_account\` (
          \`email\` text NOT NULL,
          \`url\` text NOT NULL,
          \`access_token\` text NOT NULL,
          \`refresh_token\` text NOT NULL,
          \`token_expiry\` integer,
          \`active\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`control_account_pk\` PRIMARY KEY(\`email\`, \`url\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`agent_setting\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`catalog_provider\` (
          \`id\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`catalog_setting\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`command_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`credential\` (
          \`id\` text PRIMARY KEY,
          \`integration_id\` text,
          \`label\` text NOT NULL,
          \`value\` text NOT NULL,
          \`connector_id\` text,
          \`method_id\` text,
          \`active\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event_sequence\` (
          \`aggregate_id\` text PRIMARY KEY,
          \`seq\` integer NOT NULL,
          \`owner_id\` text
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`event\` (
          \`id\` text PRIMARY KEY,
          \`aggregate_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`type\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_event_aggregate_id_event_sequence_aggregate_id_fk\` FOREIGN KEY (\`aggregate_id\`) REFERENCES \`event_sequence\`(\`aggregate_id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`instance_identity\` (
          \`id\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jh_artifact\` (
          \`plan_id\` text NOT NULL,
          \`artifact_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`hash\` text NOT NULL,
          \`content\` text NOT NULL,
          CONSTRAINT \`jh_artifact_pk\` PRIMARY KEY(\`plan_id\`, \`artifact_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jh_log\` (
          \`plan_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`entry\` text NOT NULL,
          CONSTRAINT \`jh_log_pk\` PRIMARY KEY(\`plan_id\`, \`seq\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`jh_plan\` (
          \`id\` text PRIMARY KEY,
          \`goal\` text NOT NULL,
          \`status\` text NOT NULL,
          \`state\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
      yield* tx.run(`
        CREATE TABLE \`permission\` (
          \`id\` text PRIMARY KEY,
          \`origin\` text NOT NULL,
          \`action\` text NOT NULL,
          \`resource\` text NOT NULL,
          \`effect\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`plugin_config\` (
          \`package\` text PRIMARY KEY,
          \`options\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`reference_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_context_epoch\` (
          \`session_id\` text PRIMARY KEY,
          \`baseline\` text NOT NULL,
          \`snapshot\` text NOT NULL,
          \`baseline_seq\` integer NOT NULL,
          CONSTRAINT \`fk_session_context_epoch_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_input\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`prompt\` text NOT NULL,
          \`delivery\` text NOT NULL,
          \`admitted_seq\` integer NOT NULL,
          \`promoted_seq\` integer,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_input_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_message\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`type\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_message_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session\` (
          \`id\` text PRIMARY KEY,
          \`workspace_id\` text,
          \`parent_id\` text,
          \`slug\` text NOT NULL,
          \`directory\` text NOT NULL,
          \`path\` text,
          \`title\` text NOT NULL,
          \`version\` text NOT NULL,
          \`share_url\` text,
          \`summary_additions\` integer,
          \`summary_deletions\` integer,
          \`summary_files\` integer,
          \`summary_diffs\` text,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`permission\` text,
          \`agent\` text,
          \`model\` text,
          \`system_prompt_override\` text,
          \`type\` text,
          \`priority\` integer,
          \`responder\` text,
          \`permission_mode\` text,
          \`strict\` text,
          \`introspection\` integer,
          \`quality\` integer,
          \`affective\` integer,
          \`thinking_budget\` integer,
          \`surgical_edits\` integer,
          \`ask_before_changes\` integer,
          \`result\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          \`time_compacting\` integer,
          \`time_archived\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_tag\` (
          \`session_id\` text NOT NULL,
          \`tag\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_tag_pk\` PRIMARY KEY(\`session_id\`, \`tag\`),
          CONSTRAINT \`fk_session_tag_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`todo\` (
          \`session_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_pk\` PRIMARY KEY(\`session_id\`, \`position\`),
          CONSTRAINT \`fk_todo_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`runtime_setting\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`skill_config\` (
          \`source\` text PRIMARY KEY,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`CREATE INDEX \`bash_job_owner_idx\` ON \`bash_job\` (\`owner\`);`)
      yield* tx.run(
        `CREATE INDEX \`calendar_schedule_due_idx\` ON \`calendar_schedule\` (\`enabled\`,\`next_fire_at\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`calendar_fire_occurrence_idx\` ON \`calendar_fire\` (\`schedule_id\`,\`occurrence_millis\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`messenger_binding_chat_idx\` ON \`messenger_binding\` (\`account_id\`,\`chat_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`messenger_binding_session_idx\` ON \`messenger_binding\` (\`session_id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_origin_action_resource_idx\` ON \`permission\` (\`origin\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_input_session_pending_delivery_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`,\`delivery\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_admitted_seq_idx\` ON \`session_input\` (\`session_id\`,\`admitted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_input_session_promoted_seq_idx\` ON \`session_input\` (\`session_id\`,\`promoted_seq\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_message_session_seq_idx\` ON \`session_message\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_type_seq_idx\` ON \`session_message\` (\`session_id\`,\`type\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_message_session_time_created_id_idx\` ON \`session_message\` (\`session_id\`,\`time_created\`,\`id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_message_time_created_idx\` ON \`session_message\` (\`time_created\`);`)
      yield* tx.run(`CREATE INDEX \`session_workspace_idx\` ON \`session\` (\`workspace_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_parent_idx\` ON \`session\` (\`parent_id\`);`)
      yield* tx.run(`CREATE INDEX \`session_tag_tag_idx\` ON \`session_tag\` (\`tag\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
