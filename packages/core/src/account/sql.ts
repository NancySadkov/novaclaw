import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

import { AccountV2 } from "../account"
import { Timestamps } from "../database/schema.sql"

// ⚠️ DEAD TABLES, deliberately still declared. The Console/org SaaS client that read and wrote
// them was deleted 2026-07-29 (v0.2.0 ruling 12); nothing in the tree touches these rows now.
// They stay because they exist in every already-migrated user database and `schema.gen.ts` /
// `schema.json` describe them — removing the declaration without a DROP migration is exactly the
// snapshot drift that killed boot in Wave 0 (B5). Retiring them is a three-part sequenced change
// (drop migration → regenerated snapshot → this file), not an edit to make in passing.

export const AccountTable = sqliteTable("account", {
  id: text().$type<AccountV2.ID>().primaryKey(),
  email: text().notNull(),
  url: text().notNull(),
  access_token: text().$type<AccountV2.AccessToken>().notNull(),
  refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
  token_expiry: integer(),
  ...Timestamps,
})

export const AccountStateTable = sqliteTable("account_state", {
  id: integer().primaryKey(),
  active_account_id: text()
    .$type<AccountV2.ID>()
    .references(() => AccountTable.id, { onDelete: "set null" }),
  active_org_id: text().$type<AccountV2.OrgID>(),
})

// LEGACY
export const ControlAccountTable = sqliteTable(
  "control_account",
  {
    email: text().notNull(),
    url: text().notNull(),
    access_token: text().$type<AccountV2.AccessToken>().notNull(),
    refresh_token: text().$type<AccountV2.RefreshToken>().notNull(),
    token_expiry: integer(),
    active: integer({ mode: "boolean" })
      .notNull()
      .$default(() => false),
    ...Timestamps,
  },
  (table) => [primaryKey({ columns: [table.email, table.url] })],
)
