import { sql } from "drizzle-orm"
import { sqliteTable, text, integer, index, primaryKey, real, uniqueIndex } from "drizzle-orm/sqlite-core"
import * as DatabasePath from "../database/path"
import type { SessionMessage } from "./message"
import type { Prompt } from "./prompt"
import type { SessionInput } from "./input"
import type { Snapshot } from "../snapshot"
import type { SessionSchema } from "./schema"
import { WorkspaceV2 } from "../workspace"
import { Timestamps } from "../database/schema.sql"
import type { SystemContext } from "../system-context/index"
import type { Schema } from "effect"
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
    // ⚠️ A `permission` ruleset column stood here until 2026-09-04 and was DROPPED. It was declared,
    // typed and migrated, and across all 418 references to this table in the tree, this line was the
    // only one that named it — no select, no insert, no update, and `Session.Info` never surfaced
    // it. `schema/src/session.ts` still imported its type for nothing, which was the last trace.
    // The per-session ruleset it was meant to hold is not blocked, it was never built; the MODE half
    // (`permission_mode` below) is what actually narrows down the parent chain.
    // 🔴 If a per-session ruleset ever returns it must be DENY-WINS BY CONSTRUCTION — a reducer that
    // cannot express last-wins — never by a comment asserting it. `config-resolve.ts`'s header
    // records why (v0.2.0 ruling 16 / decisions C6: the old `permissionRules` field's "deny-wins
    // accumulation" was in fact last-wins over a concatenated list, so the escalation hole was a
    // hole in dead code). Resurrecting an untyped JSON column would be the wrong start for it.
    agent: text(),
    model: text({ mode: "json" }).$type<{
      id: string
      providerID: string
      variant?: string
    }>(),
    // DEVICE AFFINITY (v0.2.0 B2): the `DeviceRegistry` id whose admission gate, batch cap and
    // fairness ledger this session's turns queue on. NULL = inherit (parent chain), then derive from
    // the resolved model's endpoint origin. A scheduling key only — it never selects the model.
    device: text(),
    // Per-session computer substrate. NULL = inherit from the parent chain, then use the instance
    // `computer.display` default. Kept as the display string because that is the whole substrate
    // binding (`config/computer.ts`); a remote host would violate the atomic-instance rule.
    control_binding: text(),
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
    // Per-session automatic memory stance. NULL = inherit; the instance Memory switch remains the ceiling.
    memory: integer({ mode: "boolean" }),
    // NULL inherits; true selects the short conversational posture without overwriting permission mode.
    short_chat: integer({ mode: "boolean" }),
    provider_recovery: text({ mode: "json" }).$type<StoredProviderRecovery>(),
    result: text({ mode: "json" }).$type<unknown>(),
    ...Timestamps,
    time_compacting: integer(),
    time_archived: integer(),
  },
  (table) => [
    index("session_workspace_idx").on(table.workspace_id),
    index("session_parent_idx").on(table.parent_id),
    // 🔴 ONE LIVE CHAT PER COLLEAGUE, enforced by the DATABASE — the constraint behind the two
    // application checks (`createSessionRecord` and `switchAgent`), both of which are check-then-act
    // and so cannot close the race between them. A colleague with two conversations is two
    // personalities wearing one name, and the roster — the only door into a colleague's chat — can
    // show exactly one of them, so the loser becomes UNREACHABLE while its tokens still roll up into
    // that colleague's totals.
    //
    // ⚠️ The three clauses are the same three both application checks use, and the exclusions are
    // load-bearing:
    //   · `parent_id IS NULL` — a SUB-AGENT inherits its officer's id, so without this every spawned
    //     worker would collide with its officer and the fleet would be one session.
    //   · `time_archived IS NULL` — "Clear chat" ARCHIVES rather than deletes, which is precisely how
    //     a fresh chat is asked for. An archived chat must not block its own successor.
    //   · `agent NOT IN ('build','plan')` — those are POSTURES, not colleagues (`AgentV2.POSTURE_IDS`).
    //     `agent` means "the agent this session RUNS AS", and measured 2026-08-24 the owner's own
    //     instances hold 55–98 live `build` roots and 76 `plan`: without this clause the index would
    //     collapse the mode most chats run as into a single conversation.
    uniqueIndex("session_agent_live_root_idx")
      .on(table.agent)
      .where(
        sql`${table.parent_id} IS NULL AND ${table.time_archived} IS NULL AND ${table.agent} IS NOT NULL AND ${table.agent} NOT IN ('build', 'plan')`,
      ),
  ],
)

// The durable ownership/fencing row for the session's CURRENT execution attempt. A new owner
// replaces this row transactionally and increments `generation`; every heartbeat/settlement is
// conditional on (attempt_id, generation), so a late worker cannot publish itself healthy or idle
// after the host has fenced it. Attempt history belongs in structured logs; this table is the small,
// authoritative recovery fact queried at boot and by Processes.
/**
 * `session_execution.served_by` holds a JSON array of serving identities, first-seen order.
 *
 * JSON rather than a delimiter because a fingerprint is an opaque vendor string — vLLM's carries
 * dashes and hex, and any separator chosen here is one some future server is free to emit.
 *
 * The codec sits beside the column rather than with either user: the drain writes it and the receipt
 * reads it, and a format owned by neither is a format that can drift on one side only.
 */
export const encodeServingIdentities = (identities: ReadonlyArray<string>): string => JSON.stringify(identities)

/**
 * ⚠️ Unreadable reads as EMPTY, never as an error. A receipt is evidence about a run that already
 * happened; refusing to compose it over one malformed provenance field would withhold the checks,
 * the plan and the terminal state — the fields a reader actually came for.
 */
export const decodeServingIdentities = (raw: string | null | undefined): ReadonlyArray<string> => {
  if (raw === null || raw === undefined || raw.length === 0) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : []
  } catch {
    return []
  }
}

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
    /**
     * WHICH serving process produced this attempt's turns (the response's `system_fingerprint`).
     *
     * A receipt says what happened; without this it cannot say what ANSWERED. The model name is the
     * alias the config asked for, so an alias repointed at different weights — or a server restarted
     * behind the same URL — leaves every receipt before and after identical.
     *
     * Nullable and expected to be null in most installs: only some wires report an identity at all.
     * Absent means "not reported", never "unknown process".
     */
    served_by: text(),
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

// Entity-lifetime permission self-revocation. This must be a row rather than process memory:
// the permission tool runs in a disposable session worker while the evaluator runs in the host.
export const SessionAutoGrantTable = sqliteTable("session_auto_grant", {
  session_id: text()
    .$type<SessionSchema.ID>()
    .primaryKey()
    .references(() => SessionTable.id, { onDelete: "cascade" }),
  mode: text().$type<"plan" | "ask" | "surgical" | "bypass" | "yolo">().notNull(),
  justification: text().notNull(),
  at: integer().notNull(),
})

// The sanctioned open component tier. Kernel config remains in typed columns; this table is for
// versioned component values introduced through the registry. `component_id = ""` is the physical
// key for a declared singleton (the service never exposes that sentinel). Lifetime is copied onto
// every row so stale attempt/bounded data remains observable even when its defining tool is absent.
export const SessionComponentTable = sqliteTable(
  "session_component",
  {
    session_id: text()
      .$type<SessionSchema.ID>()
      .notNull()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    kind: text().notNull(),
    component_id: text().notNull(),
    schema_version: integer().notNull(),
    lifetime: text().$type<"entity" | "attempt" | "bounded">().notNull(),
    attempt_id: text(),
    generation: integer(),
    expires_at: integer(),
    value: text({ mode: "json" }).$type<Schema.Json>().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.session_id, table.kind, table.component_id] }),
    index("session_component_kind_idx").on(table.kind),
    index("session_component_expiry_idx").on(table.expires_at),
  ],
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

/**
 * The declared plan, FROZEN at the moment an execution attempt opened.
 *
 * A task receipt carries the *declared plan*, and its only source is
 * `TodoTable` — which is per SESSION and mutable. A receipt pointing at the live list is not
 * order-stable: the model reorders and completes items while the attempt runs, so by the time anyone
 * reads the receipt, the "plan" it names is the plan as it ENDED, not as it was declared.
 *
 * ⚠️ Keyed on `attempt_id`, not on the session — that is the fence recovery already uses. Two
 * attempts of one session have two plans, and a receipt for the first must not show the second's.
 *
 * ⚠️ No foreign key to `session_execution.attempt_id`, deliberately. That column is overwritten in
 * place on the next attempt (`onConflictDoUpdate` on `session_id`), so a reference would either
 * cascade the older attempt's plan away or block the update — and the whole point of this table is
 * that the older attempt's plan SURVIVES its attempt.
 */
export const TodoSnapshotTable = sqliteTable(
  "todo_snapshot",
  {
    attempt_id: text().notNull(),
    content: text().notNull(),
    status: text().notNull(),
    priority: text().notNull(),
    position: integer().notNull(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.attempt_id, table.position] }),
    index("todo_snapshot_attempt_idx").on(table.attempt_id),
  ],
)

// The ECS tag component on the session entity (notes/reports/entities-review-2026-07-06.md T0): a sparse two-column store —

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
