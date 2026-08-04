export * as AccountV2 from "./account"

import { Schema } from "effect"

/**
 * ⚠️ TOMBSTONE, not a subsystem.
 *
 * The Console/org SaaS client that owned these brands — device-code login, org listing, token
 * refresh, and the `GET {account.url}/api/config` document that was merged into the instance-wide
 * GLOBAL config layer — was deleted 2026-07-29 under v0.2.0 ruling 12 (*a remote-config document
 * merged at the global layer is inbound control, not the outbound maintenance plane*). No code
 * reads or writes these tables any more.
 *
 * What survives, and only this: the four branded ids that `account/sql.ts` uses as its column
 * `$type<>`s. The `account`, `account_state` and `control_account` TABLES are deliberately still
 * declared, because they exist in every database that has ever booted this product and
 * `schema.gen.ts` / `schema.json` describe them. Dropping them is a migration, not a deletion —
 * see the follow-up filed with this commit. Do not add fields here; add nothing that reads them.
 */
export const ID = Schema.String.pipe(Schema.brand("AccountID"))
export type ID = Schema.Schema.Type<typeof ID>

export const OrgID = Schema.String.pipe(Schema.brand("OrgID"))
export type OrgID = Schema.Schema.Type<typeof OrgID>

export const AccessToken = Schema.String.pipe(Schema.brand("AccessToken"))
export type AccessToken = Schema.Schema.Type<typeof AccessToken>

export const RefreshToken = Schema.String.pipe(Schema.brand("RefreshToken"))
export type RefreshToken = Schema.Schema.Type<typeof RefreshToken>
