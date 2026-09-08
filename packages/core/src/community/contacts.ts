export * as CommunityContacts from "./contacts"

import { eq, inArray, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { CommunitySuccession } from "./succession"
import { InstanceIdentityStore } from "../instance-identity-store"
import { CommunityContactTable, CommunityObservationTable, CommunitySuccessionTable } from "./sql"

/**
 * Community P3 — the contact list (`notes/spec/community-p2p.md`).
 *
 * Two things at once, and the second is the one that matters: it is the user's address book, and it
 * is the **bootstrap set**. A user who has met anybody never needs a seed list the project controls,
 * which is where "survives an acquirer" stops being a slogan and becomes stored bytes.
 *
 * ⚠️ **Three words, three meanings — do not "tidy" them into one** (settled 2026-08-21):
 *   · `CommunityContacts` (here) — OTHER INSTANCES this user has met. The address book + bootstrap set.
 *   · `CommunityPeers` (`peers.ts`) — the ROUTING TABLE peer exchange fills. Transport, not people.
 *   · the **Contacts app** (`app/src/pages/contacts.tsx`) — the roster of THIS instance's own
 *     colleagues, which is what the owner calls "a flat of Agents contacts".
 *
 * The user never sees this module's word: the Community surface says **"People you know"**, and the
 * prose that used to say "your contacts" now says the same. So the collision is a reader's problem
 * only, and renaming either identifier would collapse two concepts that are genuinely different —
 * an address book is not a routing table.
 */

export interface Contact {
  /**
   * `nid_<base64url ed25519 public key>` — the identity, and the primary key.
   *
   * ⚠️ Always the peer's CURRENT key. Looking a contact up by a key they have since rotated away
   * from answers with the same person at the key they moved to, so a caller never has to know
   * whether the key it holds is current.
   */
  readonly networkID: string
  readonly petname?: string
  /** The user's own declaration of how far they trust this peer, 1..5. Absent = never rated. */
  readonly trust?: number
  /**
   * Keys this peer has ROTATED AWAY FROM, oldest last — everything they ever signed as.
   *
   * ⚠️ Populated by `list`, and `undefined` (not `[]`) from `get`, because the two are on different
   * paths and the distinction is "not computed here" rather than "they never rotated". `get` runs at
   * INGRESS for every arriving message, where a stranger is the common case and the ~9.8k msg/s
   * flood is the design load; gathering a chain there would trade a primary-key hit for a scan, to
   * fill in a field the ingress path never reads. Attribution — the one caller that needs it — reads
   * the list once and answers every message from it.
   */
  readonly formerIDs?: readonly string[]
  /** Last-known addresses. Plural: a peer is reachable by LAN address, public address or relay. */
  readonly routes: readonly string[]
  readonly lastSeenAt?: number
  readonly blocked: boolean
  readonly addedAt: number
}

export class ContactError extends Schema.TaggedErrorClass<ContactError>()("CommunityContacts.ContactError", {
  message: Schema.String,
}) {}

export interface Interface {
  readonly list: () => Effect.Effect<ReadonlyArray<Contact>>
  readonly get: (networkID: string) => Effect.Effect<Contact | undefined>
  /**
   * Add a peer to the address book. A TRUST decision, so it is not something an agent may do on the
   * user's behalf — see the note on `observe`.
   */
  readonly add: (input: {
    readonly networkID: string
    readonly petname?: string
    readonly routes?: readonly string[]
    /**
     * 🔴 The USER's declaration, 1..5, and the only thing that may write this column.
     *
     * ⚠️ Omitting it leaves an existing rating alone rather than clearing it — re-adding
     * somebody must not silently un-rate them, the same rule `blocked` and `last_seen_at` already
     * follow here.
     */
    readonly trust?: number
  }) => Effect.Effect<Contact, ContactError>
  readonly forget: (networkID: string) => Effect.Effect<boolean>
  readonly setBlocked: (networkID: string, blocked: boolean) => Effect.Effect<boolean>
  /**
   * Record where a KNOWN peer was last reached.
   *
   * ⚠️ Deliberately cannot create a contact. Updating the route of someone you already trust is
   * repair — the self-healing story, and safe for an agent or the transport to do automatically.
   * Learning a NEW peer through the same door would let anything that can talk to us insert itself
   * into the address book, which is a trust decision wearing a maintenance disguise.
   */
  readonly observe: (networkID: string, routes: readonly string[]) => Effect.Effect<boolean>
  /**
   * A known contact proved it moved to a new key. Move the entry, keeping everything about them.
   *
   * 🔴 `blocked` MUST survive, and this is the security point rather than a nicety: if rotation
   * cleared the block, then "rotate your key" would be the standard way to walk back into a channel
   * you were blocked from — and the person who blocked you would have no idea. Blocking is already
   * weak against a peer who rotates SILENTLY (they arrive as a stranger), so the one case we can
   * hold is the one where they hand us the proof themselves.
   *
   * ⚠️ Like `observe`, it cannot create a contact: an unknown predecessor returns false. Otherwise a
   * stranger could enter the address book by presenting a statement about a key nobody knows.
   */
  readonly follow: (statement: CommunitySuccession.Statement) => Effect.Effect<boolean>
  /**
   * Apply a BAG of statements, walking each contact to the end of its proven chain.
   *
   * 🔴 `follow` alone is order-dependent, and statements arrive from a gossip mesh in no order at
   * all. Given `B→C` before `A→B`, the first is dropped (predecessor unknown) and never retried, so
   * a contact who rotated twice while we were away would be stranded on their oldest key while the
   * proof of where they went sat in memory, already verified. This resolves the whole chain first
   * and moves once.
   *
   * Returns how many contacts moved.
   */
  readonly followAll: (statements: readonly CommunitySuccession.Statement[]) => Effect.Effect<number>
  /** Contacts usable as bootstrap entries: not blocked, and with at least one known route. */
  readonly bootstrap: () => Effect.Effect<ReadonlyArray<Contact>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityContacts") {}

const rowContact = (row: typeof CommunityContactTable.$inferSelect): Contact => ({
  ...(row.trust === null ? {} : { trust: row.trust }),
  networkID: row.network_id,
  ...(row.petname === null ? {} : { petname: row.petname }),
  routes: row.routes ?? [],
  ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  blocked: row.blocked,
  addedAt: row.time_created,
})

/**
 * The keys a peer held BEFORE `current`, newest first.
 *
 * Rows point forward (`successor_id`), so predecessors are found by walking the pointers backwards.
 * Bounded by the row count and guarded against repeats: a cycle needs a compromised key to sign a
 * rotation back to an earlier one, and an unbounded walk would be a hang rather than a wrong answer.
 */
const formerIDs = (rows: readonly (typeof CommunityContactTable.$inferSelect)[], current: string): string[] => {
  const backwards = new Map<string, string>()
  for (const entry of rows) if (entry.successor_id != null) backwards.set(entry.successor_id, entry.network_id)
  const chain: string[] = []
  const seen = new Set([current])
  for (let key = backwards.get(current); key !== undefined && !seen.has(key); key = backwards.get(key)) {
    seen.add(key)
    chain.push(key)
  }
  return chain
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const row = (networkID: string) =>
      db
        .select()
        .from(CommunityContactTable)
        .where(eq(CommunityContactTable.network_id, networkID))
        .get()
        .pipe(Effect.orDie)

    /**
     * Walk a key forward to the row holding its holder's CURRENT key.
     *
     * ⚠️ Bounded, and the bound is not paranoia about our own data. A chain is built from statements
     * signed by each predecessor, so a cycle needs a compromised key to sign a rotation back to an
     * earlier one — an attacker who has that key can do it, and an unbounded walk would then hang
     * the ingress path for every message that peer ever sent. `visited` stops at the repeat and
     * returns the last good row, which degrades to a stale attribution rather than a wedged instance.
     */
    const resolveRow = Effect.fn("CommunityContacts.resolveRow")(function* (networkID: string) {
      let current = yield* row(networkID)
      const visited = new Set([networkID])
      while (current?.successor_id != null && !visited.has(current.successor_id)) {
        visited.add(current.successor_id)
        const next = yield* row(current.successor_id)
        // A dangling pointer means the successor row was removed; the person is still this row's
        // holder as far as we know, so stop here rather than reporting them unknown.
        if (next === undefined) break
        current = next
      }
      return current
    })

    const get = Effect.fn("CommunityContacts.get")(function* (networkID: string) {
      const resolved = yield* resolveRow(networkID)
      return resolved === undefined ? undefined : rowContact(resolved)
    })

    /** The current key for `networkID`, or `networkID` itself when we know of no rotation. */
    const currentID = Effect.fn("CommunityContacts.currentID")(function* (networkID: string) {
      return (yield* resolveRow(networkID))?.network_id ?? networkID
    })

    const follow = Effect.fn("CommunityContacts.follow")(function* (statement: CommunitySuccession.Statement) {
        // Verified BEFORE anything is read or written: an unsigned claim about someone else's key is
        // exactly the shape an identity theft would take.
        if (!CommunitySuccession.verify(statement)) return false
        /**
         * ⚠️ The predecessor's OWN row, not `get`'s resolved answer. `get` now walks forward, so on
         * an already-followed chain it would return the SUCCESSOR's row and this would copy that
         * peer's details onto a new entry.
         */
        const existing = yield* row(statement.predecessor)
        if (existing === undefined) return false
        /**
         * A key rotates ONCE. Two statements from one predecessor naming different successors is a
         * fork — it needs the predecessor's key to sign both, so it means that key is compromised or
         * its holder is equivocating. Neither branch is more true than the other, so we keep the
         * chain we already proved rather than letting the later arrival redirect the contact.
         */
        if (existing.successor_id != null) return false

        // Already followed, or the successor is someone we separately know: leave both alone rather
        // than merging two people's entries into one.
        if ((yield* get(statement.successor)) !== undefined) return false

        yield* db
          .insert(CommunityContactTable)
          .values({
            network_id: statement.successor,
            // ⚠️ ROW field names, not `Contact`'s. This reads the stored row directly now, and the
            // camelCase spellings it used to carry over do not exist on it — `lastSeenAt` silently
            // read `undefined` and dropped the last-seen time on every rotation. The typechecker
            // caught it; no test could, because the loss shows up as an absent optional field.
            ...(existing.petname === null ? {} : { petname: existing.petname }),
            routes: [...existing.routes],
            // 🔴 Carried, not reset. See the interface note: otherwise rotation is a block bypass.
            blocked: existing.blocked,
            ...(existing.last_seen_at === null ? {} : { last_seen_at: existing.last_seen_at }),
          })
          .run()
          .pipe(Effect.orDie)
        /**
         * 🔴 The old row is KEPT and pointed forward, never deleted — see `successor_id`.
         *
         * Deleting it un-blocks the peer's backlog: their pre-rotation messages are signed by this
         * key, reconciliation backfills exactly such messages, and an author we know nothing about
         * passes the ingress block check. The user blocked a person; they must not receive that
         * person's history because the person changed keys.
         */
        yield* db
          .update(CommunityContactTable)
          .set({ successor_id: statement.successor })
          .where(eq(CommunityContactTable.network_id, statement.predecessor))
          .run()
          .pipe(Effect.orDie)
        return true
    })

    return Service.of({
      get,
      list: Effect.fn("CommunityContacts.list")(function* () {
        const rows = yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie)
        // ⚠️ Superseded rows are kept for lookup, never LISTED: they are the same person at an old
        // key, and showing them would turn every rotation into a duplicate in the user's address book.
        return rows
          .filter((entry) => entry.successor_id == null)
          .map((entry) => ({ ...rowContact(entry), formerIDs: formerIDs(rows, entry.network_id) }))
      }),

      add: Effect.fn("CommunityContacts.add")(function* (input) {
        /**
         * 🔴 The id must PARSE as a public key, not merely look like one.
         *
         * A contact whose id is not a key can never have a signature verified against it, so it is
         * an entry that will silently fail every check it exists to enable. Rejecting it here is the
         * difference between "you typed that wrong" and a peer that is quietly never trusted.
         */
        if (InstanceIdentityStore.parseNetworkID(input.networkID) === undefined)
          return yield* new ContactError({
            message: `Not a network identity: ${input.networkID.slice(0, 24)}… (expected nid_ followed by a 32-byte key)`,
          })

        // Re-adding someone you already know is not an error and must not wipe what you know about
        // them: `blocked` and `last_seen_at` survive because they are never in this set.
        const updates = {
          ...(input.petname === undefined ? {} : { petname: input.petname }),
          /**
           * ⚠️ Clamped, not rejected. A rating outside the scale is a caller's mistake and not a
           * reason to refuse somebody's doorman — but storing it as given would let a 9 outrank
           * every honest 5 forever, since only the ORDER of this column is ever read.
           */
          ...(input.trust === undefined ? {} : { trust: Math.min(5, Math.max(1, Math.trunc(input.trust))) }),
          ...(input.routes === undefined ? {} : { routes: [...input.routes] }),
        }
        /**
         * ⚠️ Adding someone by a key they have ROTATED AWAY FROM — the normal case when the id came
         * off an old message — updates the person we already know rather than creating a second
         * entry for them that would never receive anything.
         */
        const networkID = yield* currentID(input.networkID)
        /**
         * ⚠️ The INSERT carries the same fields as `updates`, and forgetting one here is silent:
         * a first-time add would store nothing while re-adding the same peer stored it, so the value
         * would appear only on the second attempt. That is exactly how `trust` behaved when it was
         * added to `updates` alone.
         */
        const insert = db.insert(CommunityContactTable).values({
          network_id: networkID,
          ...updates,
          routes: [...(input.routes ?? [])],
        })

        // ⚠️ An empty `set` is a THROW, not a no-op, so re-adding a bare id — the "here is my
        // identity, I will tell you where I am later" case — has to take the do-nothing branch.
        yield* (Object.keys(updates).length === 0
          ? insert.onConflictDoNothing()
          : insert.onConflictDoUpdate({ target: CommunityContactTable.network_id, set: updates })
        )
          .run()
          .pipe(Effect.orDie)

        const stored = yield* get(networkID)
        return stored ?? { networkID, routes: [], blocked: false, addedAt: Date.now() }
      }),

      forget: Effect.fn("CommunityContacts.forget")(function* (networkID: string) {
        /**
         * 🔴 Forgets the whole CHAIN, not one row. Removing only the current key would leave the
         * peer's earlier keys behind as rows that still resolve — so a user who forgot someone would
         * still be attributing that person's old messages to them, and still blocking on an entry
         * they believe is gone.
         *
         * 🔴 **And the chain is read from BOTH stores — review finding 1.17.** It used to be built
         * from contact rows alone, which left three ways for the person to survive being forgotten,
         * all measured: the succession STORE kept the rows naming their keys (and re-served them on
         * `GET /api/community/succession`, so we went on publishing somebody's key history after
         * their own user erased them); observations attached to a key linked only through that store
         * were never in the chain, so `about(B)` still returned the file on them; and a peer who was
         * never ADDED had no deletion path at all — `forget` returned false and did nothing, while
         * the consent screen promised "forgetting someone deletes theirs".
         */
        const rows = yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie)
        const statements = yield* db.select().from(CommunitySuccessionTable).all().pipe(Effect.orDie)
        /**
         * Every key we have reason to believe is the same person, walked in BOTH directions and
         * transitively — a rotation is a chain, and a user who forgets someone means all of them.
         *
         * ⚠️ Starts from the resolved contact row when there IS one, and from the bare key when
         * there is not. That single fallback is what gives a never-added peer a deletion path.
         */
        const target = (yield* resolveRow(networkID))?.network_id ?? networkID
        const chain = new Set<string>([target, ...formerIDs(rows, target)])
        for (let added = true; added; ) {
          added = false
          for (const link of statements) {
            if (chain.has(link.network_id) && !chain.has(link.successor_id)) {
              chain.add(link.successor_id)
              added = true
            }
            if (chain.has(link.successor_id) && !chain.has(link.network_id)) {
              chain.add(link.network_id)
              added = true
            }
          }
        }
        const removed = yield* db
          .delete(CommunityContactTable)
          .where(inArray(CommunityContactTable.network_id, [...chain]))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)

        /**
         * 🔴 The DOSSIER goes too — §5(k) of `notes/spec/honesty-ledger.md`, *a dossier, not a log*:
         * *"fails if `forget` leaves a score behind"*.
         *
         * There is no score column by design, but the observations ARE the file on that person: what
         * they promised, what they delivered, and this agent's own prose about them. Measured
         * 2026-08-17: forget removed the address book entry and kept every note, which is not
         * forgetting somebody — it is only losing the ability to write to them.
         *
         * ⚠️ The whole CHAIN, for the reason the rows above are chained: notes are recorded against
         * the key held AT THE TIME, so deleting only the current one would leave a person's earlier
         * identities carrying their history.
         *
         * ⚠️ Done HERE rather than by the caller, so a second caller cannot forget half. The spec
         * leaves it open whether a re-added peer's history returns; what it does not leave open is
         * the default, *because the opposite is unrecoverable once shipped*.
         */
        const forgottenNotes = yield* db
          .delete(CommunityObservationTable)
          .where(inArray(CommunityObservationTable.subject, [...chain]))
          .returning({ subject: CommunityObservationTable.subject })
          .all()
          .pipe(Effect.orDie)

        /**
         * 🔴 And the SUCCESSION rows naming them (1.17). Two reasons, and the second is the one that
         * makes this not merely tidiness: they are what re-attaches the dossier — `about` resolves
         * through this table, so a note we could not see would come back the moment the chain was
         * walked again — and `GET /api/community/succession` SERVES them, so forgetting someone
         * while continuing to publish their key history is not forgetting them at all.
         */
        const forgottenLinks = yield* db
          .delete(CommunitySuccessionTable)
          .where(
            or(
              inArray(CommunitySuccessionTable.network_id, [...chain]),
              inArray(CommunitySuccessionTable.successor_id, [...chain]),
            ),
          )
          .returning({ id: CommunitySuccessionTable.network_id })
          .all()
          .pipe(Effect.orDie)

        /**
         * ⚠️ True when ANYTHING was forgotten, not only when a contact row went. A peer we dealt with
         * but never added has no contact row by construction — that is the population the honesty
         * ledger exists for — and answering `false` while deleting their file would tell the user
         * their request did nothing.
         */
        return removed.length > 0 || forgottenNotes.length > 0 || forgottenLinks.length > 0
      }),

      setBlocked: Effect.fn("CommunityContacts.setBlocked")(function* (networkID: string, blocked: boolean) {
        // Blocking by a key the peer has rotated away from blocks the PERSON: the decision is about
        // who you refuse, and it would be worthless if it applied only to the key you happened to hold.
        const updated = yield* db
          .update(CommunityContactTable)
          .set({ blocked })
          .where(eq(CommunityContactTable.network_id, yield* currentID(networkID)))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)
        if (updated.length > 0) return true

        /**
         * 🔴 BLOCKING A STRANGER creates the row — because otherwise the promise is false.
         *
         * This updated an existing contact and did nothing when there was none, so somebody who found
         * this instance through the public directory and started asking questions could not be blocked
         * at all: the user had to ADD the person they wanted nothing to do with, first. The consent
         * screen says *"you can block people, and that is the only power anyone has here"*, and it was
         * untrue exactly where it mattered most.
         *
         * 🔴 (ff) is not violated by this, and it is worth saying why. That principle constrains
         * AUTONOMY — *"autonomy may deepen a relationship the user made and may never make one"* — and
         * the doorman door already records the other side of it: when the USER is the one making the
         * relationship, a contact may be created, because *"refusing to record that would be enforcing
         * a rule against the only party it exists to protect."* The agent cannot reach this: `block` is
         * absent from the community tool's operations and pinned absent by its ledger.
         *
         * ⚠️ Only when BLOCKING. Un-blocking somebody unknown stays a no-op — there is nothing to
         * undo, and minting a row to record the absence of a decision would be a dossier nobody asked
         * for.
         */
        if (!blocked) return false
        /**
         * ⚠️ The id must PARSE, for the reason `add` gives: an id that is not a key can never have a
         * signature verified against it, so blocking it would protect nobody from anybody. A typo must
         * not mint a row that silently guards nothing.
         */
        if (InstanceIdentityStore.parseNetworkID(networkID) === undefined) return false
        yield* db
          .insert(CommunityContactTable)
          .values({ network_id: networkID, blocked: true, routes: [] })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
        return true
      }),

      observe: Effect.fn("CommunityContacts.observe")(function* (networkID: string, routes: readonly string[]) {
        const updated = yield* db
          .update(CommunityContactTable)
          .set({ routes: [...routes], last_seen_at: Date.now() })
          // Reaching a peer at an old key still tells us where that PERSON is, so the route lands on
          // their current row rather than on a key nothing will dial again.
          .where(eq(CommunityContactTable.network_id, yield* currentID(networkID)))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)
        // No row updated = we do not know this peer. Not an error, and deliberately not an insert.
        return updated.length > 0
      }),

      follow,
      followAll: Effect.fn("CommunityContacts.followAll")(function* (
        statements: readonly CommunitySuccession.Statement[],
      ) {
        const rows = (yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie))
          // Only rows at a peer's CURRENT key: a superseded row is that same person one link back,
          // and walking it again would re-follow a chain already proved.
          .filter((entry) => entry.successor_id == null)
        let moved = 0
        for (const row of rows) {
          // `resolve` verifies every link and stops at the last PROVEN key, so an unsigned or
          // missing link leaves the contact where it was rather than guessing forward.
          const destination = CommunitySuccession.resolve(row.network_id, statements)
          if (destination === row.network_id) continue
          /**
           * Walk link by link with the REAL statements. An earlier draft handed `follow` a
           * statement with a rewritten `predecessor`, which is a forgery: changing a signed field
           * invalidates the signature, so it would have verified as false and moved nothing while
           * looking like it should work.
           */
          let current = row.network_id
          let stepped = false
          while (current !== destination) {
            const link = statements.find(
              (candidate) => candidate.predecessor === current && CommunitySuccession.verify(candidate),
            )
            if (link === undefined) break
            if (!(yield* follow(link))) break
            current = link.successor
            stepped = true
          }
          if (stepped) moved++
        }
        return moved
      }),

      bootstrap: Effect.fn("CommunityContacts.bootstrap")(function* () {
        const rows = yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie)
        return rows
          // ⚠️ A superseded row is a key its holder ROTATED AWAY FROM. Its routes may still look
          // perfectly good, and dialling them bootstraps through an identity nobody answers as.
          .filter((entry) => entry.successor_id == null)
          .map(rowContact)
          // A blocked peer is not an entry point: bootstrapping through someone whose messages you
          // refuse would reconnect you to them on every start.
          .filter((contact) => !contact.blocked && contact.routes.length > 0)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
