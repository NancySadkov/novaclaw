import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"
import { Timestamps } from "../database/schema.sql"

/**
 * Community P3 — the contact list (`notes/spec/community-p2p.md`).
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
  /**
   * 🔴 How much the USER says they trust this peer — the doorman declaration (`AGENTS.md`,
   * "Joining is doorman-FREE"). 1..5, or NULL for "never said".
   *
   * This is what the ladder is actually built from. Joining needs no doorman at all; the question
   * arrives when TRANSACTIONS do, and a user naming a host and saying how far they trust it is the
   * root the MLM-shaped structure hangs from, with the most-trusted instance at the top.
   *
   * ⚠️ A DECLARATION, never a computation. Nothing derives it, nothing updates it behind the
   * user's back, and the honesty ledger may not move it — it is the user's sentence, and (i) says
   * a user outranks the ledger. Only its ORDER is meaningful: it ranks doormen against each other
   * and carries no magnitude anybody should average.
   *
   * ⚠️ NULL is not zero, and the difference matters at exactly the moment this is read. A peer
   * the user never rated is UNRATED — the ordinary state of everyone met through peer exchange —
   * and treating that as "trusted 0" would silently rank the whole network below a stranger who was
   * typed in once.
   */
  trust: integer(),
  ...Timestamps,
})

/**
 * Community P0/P3 — addresses learned from the NETWORK, which are not contacts.
 *
 * 🔴 The distinction is the whole reason this table exists rather than a flag on `community_contact`.
 * A contact is a TRUST decision the user made; `observe` and `follow` both refuse to create one
 * precisely so that nothing which can talk to us can insert itself into the address book. Peer
 * exchange has to learn addresses from strangers, so writing them there would be that same hole
 * wearing a bootstrap disguise.
 *
 * A row here is only ever a ROUTE — somewhere the network might be reached. It confers no trust at
 * all: messages from these peers pass the identical ingress door, and a blocked contact stays
 * blocked no matter how many peers offer their address.
 *
 * ⚠️ This is what makes the spec's anti-shutdown claim literally true: *any peer address from any
 * source is a complete entry point, because peer exchange supplies the rest.* Without a place to put
 * what PX returns, one address stays one address, and a "network" that needs our seed list is one we
 * could switch off.
 */
export const CommunityPeerTable = sqliteTable("community_peer", {
  /** `nid_…` — the peer's identity. Same shape as a contact's, carrying none of the meaning. */
  network_id: text().primaryKey(),
  /** JSON array of addresses we were told reach this peer. Unverified until one of them answers. */
  routes: text({ mode: "json" }).$type<string[]>().notNull().$default(() => []),
  /** Epoch millis we last got an answer here. Null = told about it, never reached it. */
  last_seen_at: integer(),
  /**
   * Where we heard about this peer: `px` (another peer told us), `lan` (mDNS on this network).
   *
   * Kept because the sources have different trust and different failure modes — a LAN peer is
   * someone on your own network, a PX peer is hearsay from a stranger — and because a bootstrap
   * monoculture is only visible if you can see which source everything came from.
   */
  source: text().notNull().default("px"),
  /**
   * 🔴 WHICH peer told us about this one — the introduction edge (`notes/spec/honesty-ledger.md`
   * (dd)). `source` says what KIND of hearsay it was; this says whose.
   *
   * Without it a cluster and a consensus are the same shape: three peers agreeing looks like
   * independent confirmation whether they are three strangers or three faces of one operator. It is
   * the only structural defence against a honeypot guru, because everything else about their
   * cluster looks exactly like a group of peers who happen to agree.
   *
   * ⚠️ WRITE-ONCE. The first peer to tell us about somebody is who introduced them; a later
   * announcement is not a re-introduction, and letting it overwrite would hand an attacker a way to
   * launder provenance by simply being the last to mention a peer.
   *
   * ⚠️ Nullable, with no default: LAN discovery has no introducer, and rows that predate this
   * column genuinely do not know. NULL means unknown, which is not the same as "nobody" — and a
   * `$default` here would emit no SQL DEFAULT and brick the upgrade it is meant to serve.
   */
  introduced_by: text(),
  ...Timestamps,
})

/**
 * Community P1 — successor statements we have seen, kept so they can be RE-SERVED.
 *
 * 🔴 Without this, rotation strands the user against anyone who was offline at the moment it
 * happened — which is most peers, most of the time, in a network of home machines. A statement
 * pushed once and never stored reaches whoever was listening and nobody else, and the ledger named
 * that exact failure as the reason rotation stayed unexposed until a transport existed.
 *
 * ⚠️ Storing one confers nothing: a statement is self-verifying (signed by the key it retires), so
 * holding it is holding a fact anyone can check rather than a claim anyone must trust. That is
 * precisely why it is safe to pass on for someone else.
 *
 * ⚠️ `predecessor` is the PRIMARY KEY because a key rotates ONCE. Two statements from one predecessor
 * naming different successors is a fork, which needs that key to sign both — so it means the key is
 * compromised or its holder is equivocating, and the chain we already proved is the one we keep.
 */
export const CommunitySuccessionTable = sqliteTable("community_succession", {
  network_id: text().primaryKey(),
  successor_id: text().notNull(),
  /** The author's claimed time, signed. Retained because it is inside the signed bytes. */
  claimed_at: integer().notNull(),
  signature: text().notNull(),
  /**
   * 🔴 The SUCCESSOR's signature over the same canonical bytes (review 2026-08-17, finding 1.4).
   *
   * Without it a statement was signed by one side only, so anyone could point a key they hold at a
   * key they do not: a blocked attacker issued `attacker→victim` and the victim's next signed post
   * was rejected as blocked, their key listed in the address book under the attacker's petname.
   *
   * ⚠️ NOT NULL and no default. A row that predates the rule would otherwise read as co-signed
   * while carrying nothing, which is the shape a `$default` produces and the reason a column like
   * this must fail loudly instead.
   */
  successor_signature: text().notNull(),
  ...Timestamps,
})

/**
 * Community P6 — the offer THIS instance publishes, if any.
 *
 * ⚠️ Its own table rather than a `runtime_setting` row, and that is a hazard avoided rather than a
 * preference: a settings key written without being declared makes the write succeed and the NEXT
 * BOOT crash-loop, with the whole test gate green throughout. A table has no such trap, and every
 * other community store already works this way.
 *
 * One row at most — an instance offers one thing or nothing, so the id is a constant.
 */
export const CommunityOfferTable = sqliteTable("community_offer", {
  /**
   * `self` for our own offer, or the offering peer's `nid_…` for one we collected.
   *
   * ⚠️ One table rather than two, because the difference between "mine" and "theirs" is WHO SIGNED
   * it and nothing else — and a second table would invite a second set of verification rules, which
   * is how the weaker one gets forgotten.
   */
  id: text().primaryKey(),
  /** The signed offer, verbatim, so what is served is byte-identical to what was signed. */
  document: text().notNull(),
  ...Timestamps,
})


/**
 * Community — ANSWERS GIVEN to peers (`notes/spec/honesty-ledger.md` §4d).
 *
 * 🔴 A row is one answer we spent tokens on. It exists so the BUDGET can be counted, and the
 * budget is the feature: answering is the only thing this program does that spends the user's money
 * on people they have never met.
 *
 * ⚠️ A COUNT per day, not a token total, and that is deliberate. Tokens are known only after the
 * call, so a token budget can be overshot by the last answer; a count multiplied by the per-answer
 * `maxTokens` is bounded BEFORE anything is spent. The cheaper primitive is the enforceable one.
 *
 * ⚠️ Kept even when the asker is a stranger we never record a dealing about — the observation
 * store refuses subjects we have never encountered, by design, and the budget must not inherit that
 * refusal. What we spend is our own business and is always known to us.
 */
export const CommunityAnsweredTable = sqliteTable(
  "community_answered",
  {
    id: text().primaryKey(),
    /** Who asked. Recorded so a single peer cannot quietly consume the whole day's budget. */
    asker: text().notNull(),
    /** Epoch millis we answered. */
    at: integer().notNull(),
    ...Timestamps,
  },
  (table) => [index("community_answered_at_idx").on(table.at)],
)

/**
 * Community — HONESTY, the per-peer ledger (`notes/spec/honesty-ledger.md`).
 *
 * 🔴 A row is a DEALING that happened, never a verdict about a peer. No score, weight, stake or
 * confidence is stored anywhere, and that is the load-bearing decision rather than an omission:
 * every such value is a function of these rows plus a policy, and storing one freezes the policy
 * that computed it. The mechanism is the part we promised to keep cheap to change, so changing it
 * must cost a re-read and never a migration.
 *
 * ⚠️ What is recorded is what cannot be recomputed. The shape question looks like a mechanism
 * choice and is not, because the two have different costs: what you compute is reversible, what you
 * failed to record is gone. So each column below earns its place by being unrecoverable later.
 *
 * ⚠️ This table can never introduce anyone. `community_contact` is the user's sentence about who
 * they know, and a good reputation is not an introduction — exactly as `observe` and `follow`
 * already refuse to mint a contact from anything the network says. Standing derived from these rows
 * may weigh what a peer claims; it may not add, remove or unblock one.
 */
export const CommunityObservationTable = sqliteTable(
  "community_observation",
  {
    /** Time-ordered so "what happened lately with this peer" is a range scan, not a sort. */
    id: text().primaryKey(),
    /**
     * The peer, BY THE KEY THEY HELD AT THE TIME — not resolved forward before storing.
     *
     * 🔴 Storing the resolved key would rewrite history at every rotation, and the whole defence
     * against a fresh face is that the past stays attached to the person. Resolution happens on
     * READ, through the succession chain, which already answers by any key a peer ever held.
     */
    subject: text().notNull(),
    /**
     * Epoch millis the dealing HAPPENED, which is not `time_created`.
     *
     * A confirmation arriving days later is an observation about the earlier claim, so the two
     * genuinely differ, and decay and oscillation-detection both read this one.
     */
    observed_at: integer().notNull(),
    /**
     * What KIND of dealing this was.
     *
     * ⚠️ The one column that is genuinely irrecoverable. The vision names dealings that are not
     * the same thing — fabricating a news claim, blowing a deadline, failing to deliver paid work,
     * trading compute — and says a score SIZES exposure. The right size for lending compute is not
     * the right weight for believing a war report, and a peer meticulous about delivery and florid
     * about news is an ordinary peer rather than a contradiction.
     *
     * It does NOT decide whether standing is one number or several: that is a read-time policy and
     * is deliberately still open. It decides only that a per-context score can always be collapsed
     * into one, while one number can never be split back apart.
     */
    context: text().notNull(),
    /**
     * The coarse result, for counting. Prose cannot be tallied and a tally cannot be re-read for
     * nuance, so both are kept and neither substitutes for the other.
     */
    outcome: text().notNull(),
    /**
     * The agent's own words about what happened.
     *
     * ⚠️ Untrusted-adjacent: it quotes what a peer did and may quote what a peer SAID, so
     * anything rendering it owes it the same fence channel content gets.
     */
    note: text(),
    /** The message or claim this is about, when there is one — without it a dispute can only be
     * re-argued, never re-examined. */
    about: text(),
    ...Timestamps,
  },
  (table) => [index("community_observation_subject_idx").on(table.subject, table.observed_at)],
)
