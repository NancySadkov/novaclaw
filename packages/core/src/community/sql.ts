import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Community P3 — the contact list (`todo/community-p2p.md`).
 *
 * 🔴 This table is the anti-shutdown property, in storage. The network survives an acquirer, or the
 * project's death, because **any one live peer is a complete entry point** and peer exchange supplies
 * the rest — so a user who has ever met anybody never needs a seed list we control. That only holds
 * if what they met is written down here.
 *
 * ⚠️ `routes` is NOT decoration, and it was learned by running the P0 spike rather than by design.
 * Gossip bootstraps by public key ALONE, and a public key is unroutable: with no relay and no DNS
 * discovery, nothing maps it to an address and the join hangs. This table is therefore the
 * address-lookup provider the transport resolves through, which is why a contact is
 * `(id, routes)` and never an id by itself.
 */
export const CommunityContactTable = sqliteTable("community_contact", {
  /**
   * The peer's network identity — `nid_<base64url ed25519 public key>`, the primary key.
   *
   * The identity IS the key, so there is no separate id column to drift from it: two rows for one
   * peer is not a state this table can represent.
   */
  network_id: text().primaryKey(),
  /**
   * 🔴 Set when this key ROTATED: the key its holder moved to. Null = this is their current key.
   *
   * A row is therefore a KEY, and a person is the chain of rows linking their keys — which is the
   * one change that makes a rotation non-destructive. The first version DELETED the old row, and
   * that is a defect with two faces, both of which only appear once history replicates:
   *
   * 1. **Blocking becomes reversible by rotating.** Carrying `blocked` onto the successor stops the
   *    peer posting anew, but reconciliation backfills OLD messages — signed by the deleted key,
   *    from an author we no longer know anything about, so they are stored. The user blocked a
   *    person and would receive that person's backlog.
   * 2. Every message they wrote before rotating loses its author, because the key that signed it
   *    resolves to nobody.
   *
   * ⚠️ A pointer, not a JSON list of former keys, because of where the lookup happens: EVERY
   * incoming message resolves its author at ingress, and a stranger — the common case, and ~9.8k
   * per second under the measured flood — is a MISS. A miss against a list is a table scan that
   * degrades as the contact list grows; a miss against a primary key costs the same forever.
   */
  successor_id: text(),
  /**
   * What the USER calls this peer. Petnames, not global names: there is no registry, so nothing
   * stops two peers claiming "alice", and only the key distinguishes them.
   */
  petname: text(),
  /**
   * JSON array of last-known addresses. Plural and mutable — a peer moves between a LAN address, a
   * public address and a relay, and all of them are routes to the same identity.
   *
   * ⚠️ A stale route is not an error; it is the normal state of a peer that moved. Emptying this
   * does not delete the contact, it just means we have to rediscover where they are.
   */
  routes: text({ mode: "json" }).$type<string[]>().notNull().$default(() => []),
  /** Epoch millis of the last time this peer was actually reached. Null = never yet. */
  last_seen_at: integer(),
  /**
   * Blocked by the user: their messages are dropped locally.
   *
   * With no moderator, blocking is the ONLY power a user has over what they receive, so it lives on
   * the contact rather than in a side list — the thing you block is a person, not a message.
   */
  blocked: integer({ mode: "boolean" }).notNull().$default(() => false),
  ...Timestamps,
})
