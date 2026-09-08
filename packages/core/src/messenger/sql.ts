import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Messenger } from "@novaclaw/schema/messenger"

// The Messenger module's tables. Secrets NEVER live here:
// an account row points at the credential store via credential_id. Tables must live in sql.ts
// files (the drizzle config globs `src/**/sql.ts`) or the migration machinery misses them.

export const MessengerAccountTable = sqliteTable("messenger_account", {
  id: text().$type<Messenger.AccountID>().primaryKey(),
  driver_id: text().notNull(),
  label: text().notNull(),
  enabled: integer({ mode: "boolean" }).notNull(),
  credential_id: text(),
  settings: text({ mode: "json" }).notNull(),
  ...Timestamps,
})

// The seen-chat cache: for "seen"-capability drivers (a Telegram bot cannot enumerate its
// chats) this IS the pickable chat list the Tuning picker renders.
export const MessengerChatTable = sqliteTable(
  "messenger_chat",
  {
    account_id: text().$type<Messenger.AccountID>().notNull(),
    chat_id: text().notNull(),
    kind: text().$type<Messenger.ChatKind>().notNull(),
    title: text().notNull(),
    last_seen: integer().notNull(),
    // ⭐ The SOURCE LABEL (todo.md ruling 7), stored as TWO columns because who said it is part of
    // the fact. `proposed_access` is the driver's guess and is refreshed on every sighting;
    // `declared_access` is the USER'S word and `seenChat` must NEVER touch it — a driver that could
    // overwrite a declaration by reconnecting would be inferring the very thing the module's own law
    // (this file's header, and schema/messenger.ts:14-16) says is chosen, never inferred.
    // NULL on both is the honest pre-ruling-7 state of an existing row: no proposal, nobody asked.
    proposed_access: text().$type<Messenger.SourceAccess>(),
    declared_access: text().$type<Messenger.SourceAccess>(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.account_id, table.chat_id] })],
)

// Paired senders. trust: operator|client|blocked — pairing writes operator/client rows; blocked
// senders are dropped by the gateway before anything else sees them.
export const MessengerContactTable = sqliteTable(
  "messenger_contact",
  {
    account_id: text().$type<Messenger.AccountID>().notNull(),
    sender_id: text().notNull(),
    name: text().notNull(),
    trust: text().$type<Messenger.ContactTrust>().notNull(),
    paired_at: integer(),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.account_id, table.sender_id] })],
)

// One session per chat (the unique index); a session may hold several chats. Bindings are
// DELIBERATELY not a SessionConfig field: a spawned child inheriting its parent's chat binding
// would spam the remote chat — the one place inherit-by-default must not apply.
export const MessengerBindingTable = sqliteTable(
  "messenger_binding",
  {
    id: text().$type<Messenger.BindingID>().primaryKey(),
    account_id: text().$type<Messenger.AccountID>().notNull(),
    chat_id: text().notNull(),
    session_id: text().notNull(),
    trust: text().$type<Messenger.Trust>().notNull(),
    status: text().$type<Messenger.BindingStatus>().notNull(),
    ...Timestamps,
  },
  (table) => [
    uniqueIndex("messenger_binding_chat_idx").on(table.account_id, table.chat_id),
    index("messenger_binding_session_idx").on(table.session_id),
  ],
)

// Durable resume state per account (Telegram update offset, IMAP UIDVALIDITY+UID, Discord seq)
// so restarts never double-deliver or drop (messenger-plan edge #10).
export const MessengerCursorTable = sqliteTable("messenger_cursor", {
  account_id: text().$type<Messenger.AccountID>().primaryKey(),
  cursor: text({ mode: "json" }).notNull(),
  ...Timestamps,
})

/**
 * 🔴 **NC-REL-005 — the durable inbound ledger the cursor was pretending to be.**
 *
 * `MessengerCursorTable` above claims restarts "never double-deliver or drop". They can do both, and
 * the claim is what hid it: queue admission is a process-memory handoff, not durable admission.
 *   · The drivers advance the cursor after offering an update to an in-memory queue, so a process
 *     loss before `routeInbound` reaches the session SKIPS that message forever — nobody ever saw it.
 *   · If the cursor write fails after routing (the failure is ignored), the provider replays the
 *     message on reconnect and, with no `(account, chat, message)` uniqueness anywhere, the gateway
 *     drives the session with it a second time.
 *
 * One row per inbound message makes both answerable: `time_routed IS NULL` means "claimed but never
 * delivered" (re-route it), a present row with `time_routed` set means "already delivered" (skip it).
 * The cursor stays what it is — a resume hint — instead of being asked to carry a guarantee it never
 * had.
 *
 * ⚠️ The key is the PROVIDER's message id, not ours: it is the only identifier that survives a
 * replay, which is the case this exists for.
 */
export const MessengerInboundTable = sqliteTable(
  "messenger_inbound",
  {
    account_id: text().$type<Messenger.AccountID>().notNull(),
    chat_id: text().notNull(),
    message_id: text().notNull(),
    /** When the session actually received it. NULL = claimed, not yet delivered. */
    time_routed: integer(),
    ...Timestamps,
  },
  (table) => [
    primaryKey({ columns: [table.account_id, table.chat_id, table.message_id] }),
    index("messenger_inbound_routed_idx").on(table.time_routed),
  ],
)

/**
 * The daily cold-start budget (AGENTS.md #9(b): *starting* a conversation needs explicit permission
 * **and its own stricter rate limit*). **ONE ROW**, keyed by `scope`, always `"global"` —
 * `MessengerStore.INITIATION_SCOPE`.
 *
 * 🔴 **Why a table and not a counter in the gateway's heap.** NovaClaw's supervisor
 * **deliberately auto-restarts a crashed server** (AGENTS.md → *It never breaks in your hands*), so
 * a restart is a designed, routine event — and a rate limit that a routine event resets is not a
 * rate limit. An in-memory bucket would let a crash-loop or a restart-happy day spray well past the
 * cap on the owner's real account, which is the exact outcome principle 9 exists to prevent.
 *
 * ⚠️ **Why ONE row and not one per account.** Two reasons, and the second is the one that decides it.
 * (a) Principle 9(a) makes the outbound governor *"one hand"* — global across every chat and every
 * account, because what a provider (and a recipient) sees is one person's behaviour, not one
 * connection's. (b) Keying by account would quietly MULTIPLY the shipped cap by the number of
 * configured accounts. Per-account is a strictly looser policy and has to be argued for on its own
 * evidence; it is not a default to drift into.
 *
 * `day` is an **ISO-8601 UTC calendar date** (`YYYY-MM-DD`) — see `MessengerStore.initiationDay` for
 * why UTC, and `chargeInitiation` for the one atomic statement that rolls it over.
 */
export const MessengerInitiationTable = sqliteTable("messenger_initiation", {
  scope: text().primaryKey(),
  day: text().notNull(),
  count: integer().notNull(),
  ...Timestamps,
})
