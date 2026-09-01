import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Community P4 — channel subscriptions and the message log (`notes/spec/community-p2p.md`).
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
  /**
   * 🔴 Whether this instance tells other people it is in this channel.
   *
   * Discovery and privacy are the same question asked from two sides, and this is where the user
   * answers it. A discovery reply that named every joined channel would hand a stranger the map of
   * where this instance talks, so it names only what the user marked here.
   *
   * ⚠️ **What this buys, stated exactly — review finding 1.10 corrected a claim that was too
   * strong.** The sync endpoints answer an unknown topic exactly like an EMPTY joined one, so a
   * prober learns nothing from a quiet room. They do NOT hide a room that has messages in it: for a
   * joined room with content the digests are non-empty, and one measured probe (`#backlog`, joined,
   * 3 messages → 3 non-empty of 64 buckets; `#private`, joined and empty, and `#neverjoined` → 0)
   * tells membership from non-membership. Someone who knows the room NAME and can post one
   * proof-of-work message into it can therefore confirm we are there.
   *
   * ⚠️ That is accepted rather than fixed, and `AGENTS.md` is why: *"Being findable is the price…
   * the alternative is a server that knows who is online, so this is accepted and the consent screen
   * says it plainly."* Gating sync on `listed` would close it and break catch-up in exactly the
   * rooms this flag exists to keep quiet. So `listed` means **we never ANNOUNCE this room**, not
   * "nobody can tell".
   *
   * ⚠️ Defaults to FALSE, which is the opposite of principle 12(a)'s "work by default", and
   * deliberately so: the default here is not a convenience setting but a disclosure, and the harm of
   * over-sharing is not symmetric with the annoyance of a toggle. `#NovaClaw` is listed at join time
   * because every instance is in it, so saying so reveals nothing anyone did not already assume.
   *
   * ⚠️ `.default(false)`, NOT `$default(() => false)` — the JS form emits no SQL DEFAULT and SQLite
   * refuses `ADD COLUMN ... NOT NULL` without one. That exact mistake bricked a real instance's boot
   * on this very table, with the whole test gate green, because test databases are built fresh and
   * never take the incremental upgrade path.
   */
  listed: integer({ mode: "boolean" }).notNull().default(false),
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
    /**
     * 🔴 The proof-of-work nonce, and it MUST be persisted.
     *
     * Replication hands stored messages to other instances, and every receiver's ingress door
     * refuses work it cannot verify. A log that dropped the nonce would hold messages that are
     * perfectly valid locally and REJECTED by every peer they are offered to — replication failing
     * silently and completely, with each side believing the other was at fault.
     */
    /**
     * ⚠️ `.default(0)`, NOT `$default(() => 0)`. The `$` form is a JAVASCRIPT default applied on
     * insert; it emits no `DEFAULT` in the DDL, and SQLite refuses `ADD COLUMN ... NOT NULL` without
     * one. That shipped and BRICKED a real instance: every test passed because test databases are
     * built fresh from the full schema and never take the incremental path a real upgrade takes.
     */
    nonce: integer().notNull().default(0),
  },
  (table) => [index("community_message_channel_idx").on(table.channel, table.received_at)],
)

/**
 * Community P5 — what the USER said they do not want to read.
 *
 * 🔴 The owner's ask: *"users can block messages from the users they dislike, and also tell their Nova
 * to filter what messages they dislike."* Blocking is about a PERSON and drops at ingress; this is
 * about WORDS and hides at read. The difference is deliberate:
 *
 *   - A block says "I refuse to receive this person", so dropping early also stops them filling the
 *     disk at the measured 9.8k msg/s. Unblocking cannot recover what was never stored, which is the
 *     right way round for a decision about a person.
 *   - A filter says "not interested in this right now". It changes often, and a user who removes one
 *     expects the messages back — so filtering at INGRESS would silently destroy history on a
 *     preference they can flip in a second.
 *
 * ⚠️ Patterns are matched as plain, case-insensitive SUBSTRINGS, never as regular expressions. A
 * user-supplied regex is a denial of service against its own author — one catastrophic-backtracking
 * pattern and every channel read hangs — and "why did my messages stop loading" is an unanswerable
 * question for the person who typed it.
 */
export const CommunityFilterTable = sqliteTable("community_filter", {
  /** The pattern as typed, lowercased for matching. It is also the key: the same rule twice is one. */
  pattern: text().primaryKey(),
  ...Timestamps,
})
