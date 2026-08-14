import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Community P4 — channel subscriptions and the message log (`todo/community-p2p.md`).
 *
 * 🔴 Gossip delivers to whoever is ONLINE. A forum whose messages vanish for anyone who was away is
 * not a forum, so history is not a later feature — it is the half of P4 that gossip does not
 * provide. Every instance keeps its own log and is therefore a partial archive; there is no central
 * copy to seize, which is the same resilience argument as the contact list.
 */

export const CommunityChannelTable = sqliteTable("community_channel", {
  /** The channel name as typed, e.g. `#NovaClaw`. The topic id is derived from it by hashing. */
  name: text().primaryKey(),
  /** Muted: still subscribed, but the UI stays quiet. Distinct from leaving. */
  muted: integer({ mode: "boolean" }).notNull().$default(() => false),
  ...Timestamps,
})

export const CommunityMessageTable = sqliteTable(
  "community_message",
  {
    /** SHA-256 of the canonical signed bytes. Stable across peers, so it is also the dedup key. */
    id: text().primaryKey(),
    channel: text().notNull(),
    /** `nid_…` of the author. Not a foreign key: most authors are strangers, not contacts. */
    author: text().notNull(),
    /**
     * ⚠️ The author's CLAIMED time. Signed, therefore unforgeable by others — and freely chosen by
     * the author, who can put it in the future.
     */
    claimed_at: integer().notNull(),
    /**
     * 🔴 When WE received it, and the reason both columns exist.
     *
     * Ordering a channel by `claimed_at` alone lets one peer pin itself to the top of every reader's
     * view forever by dating its messages in the year 3000. There is no authority here to issue
     * trusted timestamps, so the only time we can vouch for is our own.
     */
    received_at: integer().notNull(),
    body: text().notNull(),
    /** Retained so a stored message can be re-verified later, or handed on to another peer intact. */
    signature: text().notNull(),
  },
  (table) => [index("community_message_channel_idx").on(table.channel, table.received_at)],
)
