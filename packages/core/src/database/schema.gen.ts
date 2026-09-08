import { Effect } from "effect"
import type { DatabaseMigration } from "./migration"

export default {
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
      yield* tx.run(`
        CREATE TABLE \`community_channel\` (
          \`name\` text PRIMARY KEY,
          \`muted\` integer NOT NULL,
          \`listed\` integer DEFAULT false NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_filter\` (
          \`pattern\` text PRIMARY KEY,
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
          \`signature\` text NOT NULL,
          \`nonce\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_direct_message\` (
          \`id\` text PRIMARY KEY,
          \`peer\` text NOT NULL,
          \`direction\` text NOT NULL,
          \`body\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`received_at\` integer NOT NULL,
          \`signature\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
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
        CREATE TABLE \`memory_access\` (
          \`id\` text PRIMARY KEY,
          \`recall_id\` text NOT NULL,
          \`fingerprint\` text NOT NULL,
          \`surface\` text NOT NULL,
          \`memory_id\` text NOT NULL,
          \`scope\` text NOT NULL,
          \`rank\` integer NOT NULL,
          \`score\` real NOT NULL,
          \`accessed_at\` integer NOT NULL,
          \`used_at\` integer,
          \`useful_at\` integer,
          \`corrected_at\` integer
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`memory_usage\` (
          \`memory_id\` text PRIMARY KEY,
          \`scope\` text NOT NULL,
          \`conflict_key\` text,
          \`first_accessed_at\` integer NOT NULL,
          \`last_accessed_at\` integer NOT NULL,
          \`accesses\` integer DEFAULT 0 NOT NULL,
          \`uses\` integer DEFAULT 0 NOT NULL,
          \`useful\` integer DEFAULT 0 NOT NULL,
          \`corrections\` integer DEFAULT 0 NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_nudge_delivery\` (
          \`session_id\` text NOT NULL,
          \`nudge_id\` text NOT NULL,
          \`occurrence\` text NOT NULL,
          \`fired_at\` integer NOT NULL,
          CONSTRAINT \`session_nudge_delivery_pk\` PRIMARY KEY(\`session_id\`, \`nudge_id\`)
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`calendar_fire\` (
          \`id\` text PRIMARY KEY,
          \`schedule_id\` text NOT NULL,
          \`occurrence_millis\` integer NOT NULL,
          \`fired_at\` integer NOT NULL,
          \`session_id\` text,
          \`status\` text NOT NULL,
          \`outcome\` text DEFAULT 'pending' NOT NULL,
          CONSTRAINT \`fk_calendar_fire_schedule_id_calendar_schedule_id_fk\` FOREIGN KEY (\`schedule_id\`) REFERENCES \`calendar_schedule\`(\`id\`) ON DELETE CASCADE
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
        CREATE TABLE \`session_compaction_request\` (
          \`session_id\` text PRIMARY KEY,
          \`requested_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_memory_cleanup\` (
          \`session_id\` text PRIMARY KEY,
          \`requested_at\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_quality_check\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`label\` text NOT NULL,
          \`command\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`exit_code\` integer,
          \`timed_out\` integer DEFAULT false NOT NULL,
          \`duration_ms\` integer,
          \`time_created\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_policy_decision\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`tool_call_id\` text NOT NULL,
          \`tool\` text NOT NULL,
          \`decision\` text NOT NULL,
          \`detail\` text NOT NULL,
          \`providers\` text NOT NULL,
          \`patched\` text,
          \`time_created\` integer NOT NULL
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
        CREATE TABLE \`web_host_budget\` (
          \`host\` text PRIMARY KEY,
          \`day\` text NOT NULL,
          \`count\` integer DEFAULT 0 NOT NULL,
          \`tokens\` real DEFAULT 0 NOT NULL,
          \`updated_at\` integer NOT NULL
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
        CREATE TABLE \`agent_status\` (
          \`agent\` text PRIMARY KEY,
          \`task\` text NOT NULL,
          \`observed\` integer NOT NULL,
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
        CREATE TABLE \`community_answered\` (
          \`id\` text PRIMARY KEY,
          \`asker\` text NOT NULL,
          \`at\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_contact\` (
          \`network_id\` text PRIMARY KEY,
          \`successor_id\` text,
          \`petname\` text,
          \`routes\` text NOT NULL,
          \`last_seen_at\` integer,
          \`blocked\` integer NOT NULL,
          \`trust\` integer,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_observation\` (
          \`id\` text PRIMARY KEY,
          \`subject\` text NOT NULL,
          \`observed_at\` integer NOT NULL,
          \`context\` text NOT NULL,
          \`outcome\` text NOT NULL,
          \`note\` text,
          \`about\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_offer\` (
          \`id\` text PRIMARY KEY,
          \`document\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_peer\` (
          \`network_id\` text PRIMARY KEY,
          \`routes\` text NOT NULL,
          \`last_seen_at\` integer,
          \`source\` text DEFAULT 'px' NOT NULL,
          \`introduced_by\` text,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`community_succession\` (
          \`network_id\` text PRIMARY KEY,
          \`successor_id\` text NOT NULL,
          \`claimed_at\` integer NOT NULL,
          \`signature\` text NOT NULL,
          \`successor_signature\` text NOT NULL,
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
          \`public_key\` text,
          \`secret_key\` text,
          \`sealing_public_key\` text,
          \`sealing_secret_key\` text,
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
          \`proposed_access\` text,
          \`declared_access\` text,
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
      yield* tx.run(`
        CREATE TABLE \`messenger_initiation\` (
          \`scope\` text PRIMARY KEY,
          \`day\` text NOT NULL,
          \`count\` integer NOT NULL,
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
        CREATE TABLE \`reference_config\` (
          \`name\` text PRIMARY KEY,
          \`layers\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_auto_grant\` (
          \`session_id\` text PRIMARY KEY,
          \`mode\` text NOT NULL,
          \`justification\` text NOT NULL,
          \`at\` integer NOT NULL,
          CONSTRAINT \`fk_session_auto_grant_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_compaction\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`seq\` integer NOT NULL,
          \`prefix_seq\` integer NOT NULL,
          \`prefix_hash\` text NOT NULL,
          \`reason\` text NOT NULL,
          \`summary\` text NOT NULL,
          \`recent\` text NOT NULL,
          \`metadata\` text,
          \`time_created\` integer NOT NULL,
          CONSTRAINT \`fk_session_compaction_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`session_component\` (
          \`session_id\` text NOT NULL,
          \`kind\` text NOT NULL,
          \`component_id\` text NOT NULL,
          \`schema_version\` integer NOT NULL,
          \`lifetime\` text NOT NULL,
          \`attempt_id\` text,
          \`generation\` integer,
          \`expires_at\` integer,
          \`value\` text NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`session_component_pk\` PRIMARY KEY(\`session_id\`, \`kind\`, \`component_id\`),
          CONSTRAINT \`fk_session_component_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
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
        CREATE TABLE \`session_execution\` (
          \`session_id\` text PRIMARY KEY,
          \`attempt_id\` text NOT NULL UNIQUE,
          \`generation\` integer NOT NULL,
          \`owner_id\` text NOT NULL,
          \`state\` text NOT NULL,
          \`phase\` text NOT NULL,
          \`failure_class\` text,
          \`failure_detail\` text,
          \`served_by\` text,
          \`failure_count\` integer DEFAULT 0 NOT NULL,
          \`heartbeat_at\` integer NOT NULL,
          \`checkpoint_at\` integer,
          \`tool_call_id\` text,
          \`tool_name\` text,
          \`tool_side_effect\` text,
          \`tool_state\` text,
          \`provider_recovery\` text,
          \`started_at\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`fk_session_execution_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
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
          \`summary_from\` text,
          \`summary_to\` text,
          \`summary_complete\` integer,
          \`metadata\` text,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`revert\` text,
          \`agent\` text,
          \`model\` text,
          \`device\` text,
          \`control_binding\` text,
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
          \`safe_mode\` integer,
          \`context_budget\` integer,
          \`memory\` integer,
          \`short_chat\` integer,
          \`provider_recovery\` text,
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
        CREATE TABLE \`todo_snapshot\` (
          \`attempt_id\` text NOT NULL,
          \`content\` text NOT NULL,
          \`status\` text NOT NULL,
          \`priority\` text NOT NULL,
          \`position\` integer NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`todo_snapshot_pk\` PRIMARY KEY(\`attempt_id\`, \`position\`)
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
      yield* tx.run(`
        CREATE TABLE \`tool_catalogue\` (
          \`scope\` text NOT NULL,
          \`name\` text NOT NULL,
          \`server\` text NOT NULL,
          \`description\` text NOT NULL,
          \`argument_names\` text NOT NULL,
          \`arguments\` text NOT NULL,
          \`input_schema\` text NOT NULL,
          \`keywords\` text DEFAULT '' NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL,
          CONSTRAINT \`tool_catalogue_pk\` PRIMARY KEY(\`scope\`, \`name\`)
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`community_message_channel_idx\` ON \`community_message\` (\`channel\`,\`received_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`community_direct_message_peer_idx\` ON \`community_direct_message\` (\`peer\`,\`received_at\`);`,
      )
      yield* tx.run(`CREATE INDEX \`memory_access_memory_idx\` ON \`memory_access\` (\`memory_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_access_recall_idx\` ON \`memory_access\` (\`recall_id\`);`)
      yield* tx.run(`CREATE INDEX \`memory_access_at_idx\` ON \`memory_access\` (\`accessed_at\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_scope_idx\` ON \`memory_usage\` (\`scope\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_conflict_idx\` ON \`memory_usage\` (\`conflict_key\`);`)
      yield* tx.run(`CREATE INDEX \`memory_usage_last_idx\` ON \`memory_usage\` (\`last_accessed_at\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`calendar_fire_occurrence_idx\` ON \`calendar_fire\` (\`schedule_id\`,\`occurrence_millis\`);`,
      )
      yield* tx.run(`CREATE INDEX \`calendar_fire_fired_at_idx\` ON \`calendar_fire\` (\`fired_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`calendar_schedule_due_idx\` ON \`calendar_schedule\` (\`enabled\`,\`next_fire_at\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_quality_check_session_idx\` ON \`session_quality_check\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_policy_decision_session_idx\` ON \`session_policy_decision\` (\`session_id\`,\`time_created\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_policy_decision_call_idx\` ON \`session_policy_decision\` (\`tool_call_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`bash_job_owner_idx\` ON \`bash_job\` (\`owner\`);`)
      yield* tx.run(`CREATE INDEX \`community_answered_at_idx\` ON \`community_answered\` (\`at\`);`)
      yield* tx.run(
        `CREATE INDEX \`community_observation_subject_idx\` ON \`community_observation\` (\`subject\`,\`observed_at\`);`,
      )
      yield* tx.run(`CREATE UNIQUE INDEX \`event_aggregate_seq_idx\` ON \`event\` (\`aggregate_id\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`event_aggregate_type_seq_idx\` ON \`event\` (\`aggregate_id\`,\`type\`,\`seq\`);`)
      yield* tx.run(`CREATE INDEX \`jh_plan_time_updated_id_idx\` ON \`jh_plan\` (\`time_updated\`,\`id\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`messenger_binding_chat_idx\` ON \`messenger_binding\` (\`account_id\`,\`chat_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`messenger_binding_session_idx\` ON \`messenger_binding\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`messenger_inbound_routed_idx\` ON \`messenger_inbound\` (\`time_routed\`);`)
      yield* tx.run(
        `CREATE UNIQUE INDEX \`permission_origin_action_resource_idx\` ON \`permission\` (\`origin\`,\`action\`,\`resource\`);`,
      )
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_compaction_session_seq_idx\` ON \`session_compaction\` (\`session_id\`,\`seq\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_compaction_session_prefix_idx\` ON \`session_compaction\` (\`session_id\`,\`prefix_seq\`);`,
      )
      yield* tx.run(`CREATE INDEX \`session_component_kind_idx\` ON \`session_component\` (\`kind\`);`)
      yield* tx.run(`CREATE INDEX \`session_component_expiry_idx\` ON \`session_component\` (\`expires_at\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_execution_state_heartbeat_idx\` ON \`session_execution\` (\`state\`,\`heartbeat_at\`);`,
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
      yield* tx.run(
        `CREATE UNIQUE INDEX \`session_agent_live_root_idx\` ON \`session\` (\`agent\`) WHERE "session"."parent_id" IS NULL AND "session"."time_archived" IS NULL AND "session"."agent" IS NOT NULL AND "session"."agent" NOT IN ('build', 'plan');`,
      )
      yield* tx.run(`CREATE INDEX \`session_tag_tag_idx\` ON \`session_tag\` (\`tag\`);`)
      yield* tx.run(`CREATE INDEX \`todo_snapshot_attempt_idx\` ON \`todo_snapshot\` (\`attempt_id\`);`)
      yield* tx.run(`CREATE INDEX \`todo_session_idx\` ON \`todo\` (\`session_id\`);`)
      yield* tx.run(`CREATE INDEX \`tool_catalogue_scope_server_idx\` ON \`tool_catalogue\` (\`scope\`,\`server\`);`)
    })
  },
} satisfies Omit<DatabaseMigration.Migration, "id">
