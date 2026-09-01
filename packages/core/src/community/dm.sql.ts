import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Community P3 — direct messages (`notes/spec/community-p2p.md`).
 *
 * 🔴 **Stored as PLAINTEXT, and that is not an oversight.** The seal uses an ephemeral sender key per
 * message and discards it, which is the forward secrecy — so an instance CANNOT reopen a message it
 * sent, even a second later. Keeping only ciphertext would mean a user's own outbox was unreadable to
 * them while remaining readable to the recipient, which is a strange and useless property.
 *
 * So what the network guarantees and what the disk guarantees are different things, stated plainly:
 * on the wire only the recipient can read it; at rest it is protected by the machine and whatever
 * guards the instance directory. The same is true of every messenger that shows you your own history.
 */
export const CommunityDirectMessageTable = sqliteTable(
  "community_direct_message",
  {
    /** SHA-256 of the canonical signed bytes — stable across both parties, so it is also the dedup key. */
    id: text().primaryKey(),
    /**
     * The OTHER party's `nid_…`, whichever direction the message went.
     *
     * ⚠️ One column rather than from/to, because a conversation is with a person: reading a thread
     * would otherwise be a query that has to remember which side we were on, and getting that wrong
     * shows a user someone else's half of the conversation.
     */
    peer: text().notNull(),
    /** `out` if we wrote it, `in` if they did. */
    direction: text().notNull(),
    /** The message as a person reads it — see the note above on why this is not ciphertext. */
    body: text().notNull(),
    /** The author's CLAIMED time, signed and freely chosen by them. */
    claimed_at: integer().notNull(),
    /** When THIS instance received or sent it — the only time we can vouch for, and the sort key. */
    received_at: integer().notNull(),
    /** Retained so a stored message can be re-verified later against its author's key. */
    signature: text().notNull(),
    ...Timestamps,
  },
  (table) => [index("community_direct_message_peer_idx").on(table.peer, table.received_at)],
)
