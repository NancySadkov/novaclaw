import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Messenger } from "@novaclaw/schema/messenger"

// The Messenger module's five tables (notes/messenger-plan.md §3.1). Secrets NEVER live here:
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
