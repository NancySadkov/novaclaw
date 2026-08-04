import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import type { SessionSchema } from "./schema"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import { AgentV2 } from "../agent"
import type { Revert } from "@novaclaw/schema/revert"
import type { SessionProviderRecovery } from "@novaclaw/schema/session-provider-recovery"

type SessionMessageData = Omit<(typeof SessionMessage.Message)["Encoded"], "type" | "id">
export type StoredProviderRecovery = Omit<SessionProviderRecovery.Info, "startedAt"> & { readonly startedAt: number }

export const SessionTable = sqliteTable(
  "session",
  {
    id: text().$type<SessionSchema.ID>().primaryKey(),
    workspace_id: text().$type<WorkspaceV2.ID>(),
    parent_id: text().$type<SessionSchema.ID>(),
    slug: text().notNull(),
    directory: DatabasePath.directoryColumn().notNull(),
    path: DatabasePath.pathColumn(),
    title: text().notNull(),
    version: text().notNull(),
    share_url: text(),
    summary_additions: integer(),
    summary_deletions: integer(),
    summary_files: integer(),
    summary_diffs: text({ mode: "json" }).$type<Snapshot.LegacyFileDiff[]>(),
    summary_from: text(),
    summary_to: text(),
    summary_complete: integer({ mode: "boolean" }),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    cost: real().notNull().default(0),
    tokens_input: integer().notNull().default(0),
    tokens_output: integer().notNull().default(0),
    tokens_reasoning: integer().notNull().default(0),
    tokens_cache_read: integer().notNull().default(0),
    tokens_cache_write: integer().notNull().default(0),
    revert: text({ mode: "json" }).$type<Revert.State>(),
    permission: text({ mode: "json" }).$type<PermissionRuleset.Ruleset>(),
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    system_prompt_override: text(),
    type: text().$type<"interactive" | "sub-agent" | "auto-prompting" | "goal-oriented">(),
    priority: integer(),
    responder: text().$type<"nova" | "operator">(),
    permission_mode: text().$type<"plan" | "ask" | "surgical" | "bypass" | "yolo">(),
    // The per-session Strict-harness override (the composer switch): enabled + racing attempts +
    // wallMinutes. NULL = inherit (parent chain, then the global `config.strict`).
    strict: text({ mode: "json" }).$type<{ enabled?: boolean; attempts?: number; wallMinutes?: number }>(),
    // Per-session harness-feature overrides (the composer's Tuning control). NULL = inherit
    // (parent chain, then the matching global config block's `enabled`).
    introspection: integer({ mode: "boolean" }),
    quality: integer({ mode: "boolean" }),
    affective: integer({ mode: "boolean" }),
    thinking_budget: integer({ mode: "boolean" }),
    surgical_edits: integer({ mode: "boolean" }),
    ask_before_changes: integer({ mode: "boolean" }),
    // SAFE MODE (owner 2026-07-30): the opt-in half of "unattended `bash` is ALLOWED by default".
    // ON = an unattended chain's host execution must be sandbox-confined, and is REFUSED on a host
    // with no backend. Tri-state like the switches above; NULL = inherit, effective default OFF.
    safe_mode: integer({ mode: "boolean" }),
    context_budget: integer({ mode: "boolean" }),
    provider_recovery: text({ mode: "json" }).$type<StoredProviderRecovery>(),
    result: text({ mode: "json" }).$type<unknown>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [index("session_workspace_idx").on(table.workspace_id), index("session_parent_idx").on(table.parent_id)],
)

// The durable ownership/fencing row for the session's CURRENT execution attempt. A new owner
// replaces this row transactionally and increments `generation`; every heartbeat/settlement is
// conditional on (attempt_id, generation), so a late worker cannot publish itself healthy or idle
// after the host has fenced it. Attempt history belongs in structured logs; this table is the small,
// authoritative recovery fact queried at boot and by Processes.
export const SessionExecutionTable = sqliteTable(
  "session_execution",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    attempt_id: text().notNull().unique(),
    generation: integer().notNull(),
    owner_id: text().notNull(),
    state: text()
      .$type<"starting" | "busy" | "recovering" | "paused" | "failed" | "interrupted" | "settled">()
      .notNull(),
    phase: text().$type<"drain" | "provider" | "tool" | "maintenance">().notNull(),
    failure_class: text(),
    failure_detail: text(),
    failure_count: integer().notNull().default(0),
    heartbeat_at: integer().notNull(),
    checkpoint_at: integer(),
    tool_call_id: text(),
    tool_name: text(),
    tool_side_effect: text().$type<"read" | "idempotent-write" | "non-idempotent" | "external-unknown">(),
    tool_state: text().$type<"dispatched" | "settled">(),
    // Transitional compatibility: the authoritative, FENCED copy lives with the execution lease.
    // SessionTable.provider_recovery remains only until old databases/UI readers have migrated.
    provider_recovery: text({ mode: "json" }).$type<StoredProviderRecovery>(),
    started_at: integer().notNull(),
    time_updated: integer().notNull(),
  },
  (table) => [index("session_execution_state_heartbeat_idx").on(table.state, table.heartbeat_at)],
)

export const TodoTable = sqliteTable(
  "todo",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.position] }),
    index("todo_session_idx").on(table.session_id),
  ],
)

// The ECS tag component on the session entity (notes/entities.md T0): a sparse two-column store —
// organization over chat processes lives here, never as structure on the session row itself.
export const SessionTagTable = sqliteTable(
  "session_tag",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    tag: text().notNull(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.session_id, table.tag] }), index("session_tag_tag_idx").on(table.tag)],
)

export const SessionMessageTable = sqliteTable(
  "session_message",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    type: text().$type<SessionMessage.Type>().notNull(),
    seq: integer().notNull(),
    ...Timestamps,
    data: text({ mode: "json" }).notNull().$type<SessionMessageData>(),
  },
  (table) => [
    uniqueIndex("session_message_session_seq_idx").on(table.session_id, table.seq),
    index("session_message_session_type_seq_idx").on(table.session_id, table.type, table.seq),
    index("session_message_session_time_created_id_idx").on(table.session_id, table.time_created, table.id),
    index("session_message_time_created_idx").on(table.time_created),
  ],
)

// Compaction is a derived context overlay, not transcript content. The source messages remain
// intact in `session_message`; this row says exactly which canonical prefix the summary replaces.
export const SessionCompactionTable = sqliteTable(
  "session_compaction",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    seq: integer().notNull(),
    prefix_seq: integer().notNull(),
    prefix_hash: text().notNull(),
    reason: text().$type<"auto" | "manual">().notNull(),
    summary: text().notNull(),
    recent: text().notNull(),
    metadata: text({ mode: "json" }).$type<Record<string, unknown>>(),
    time_created: integer().notNull(),
  },
  (table) => [
    uniqueIndex("session_compaction_session_seq_idx").on(table.session_id, table.seq),
    index("session_compaction_session_prefix_idx").on(table.session_id, table.prefix_seq),
  ],
)

export const SessionInputTable = sqliteTable(
  "session_input",
  {
    id: text().$type<SessionMessage.ID>().primaryKey(),
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    prompt: text({ mode: "json" }).notNull().$type<Prompt>(),
    delivery: text().$type<SessionInput.Delivery>().notNull(),
    admitted_seq: integer().notNull(),
    promoted_seq: integer(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [
    index("session_input_session_pending_delivery_seq_idx").on(
      table.session_id,
      table.promoted_seq,
      table.delivery,
      table.admitted_seq,
    ),
    uniqueIndex("session_input_session_admitted_seq_idx").on(table.session_id, table.admitted_seq),
    uniqueIndex("session_input_session_promoted_seq_idx").on(table.session_id, table.promoted_seq),
  ],
)

export const SessionContextEpochTable = sqliteTable("session_context_epoch", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  baseline: text().notNull(),
  snapshot: text({ mode: "json" }).notNull().$type<SystemContext.Snapshot>(),
  baseline_seq: integer().notNull(),
})
