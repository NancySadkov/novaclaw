import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"
import type { Credential } from "../credential"

export const CredentialTable = sqliteTable("credential", {
  id: text().$type<Credential.ID>().primaryKey(),
  integration_id: text().$type<Credential.Info["integrationID"]>(),
  label: text().notNull(),
  // 🔴 **Plaintext JSON, not ciphertext.** Ruling 5 of `notes/reports/decisions-v0.2.0.md`:
  // secrets stay plaintext under OS account protection. `Credential.encode` is a bare
  // `JSON.stringify`, and reading a row that still holds a legacy AES-GCM envelope OPENS it and
  // writes the plaintext back — the drain runs in that direction now. Anyone reasoning about how
  // to protect this database must assume its contents are readable.
  value: text().notNull(),
  connector_id: text(),
  method_id: text(),
  active: integer({ mode: "boolean" }),
  ...Timestamps,
})
