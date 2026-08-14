export * as CommunityContacts from "./contacts"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"
import { CommunityContactTable } from "./sql"

/**
 * Community P3 — the contact list (`todo/community-p2p.md`).
 *
 * Two things at once, and the second is the one that matters: it is the user's address book, and it
 * is the **bootstrap set**. A user who has met anybody never needs a seed list the project controls,
 * which is where "survives an acquirer" stops being a slogan and becomes stored bytes.
 */

export interface Contact {
  /** `nid_<base64url ed25519 public key>` — the identity, and the primary key. */
  readonly networkID: string
  readonly petname?: string
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
  /** Contacts usable as bootstrap entries: not blocked, and with at least one known route. */
  readonly bootstrap: () => Effect.Effect<ReadonlyArray<Contact>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityContacts") {}

const rowContact = (row: typeof CommunityContactTable.$inferSelect): Contact => ({
  networkID: row.network_id,
  ...(row.petname === null ? {} : { petname: row.petname }),
  routes: row.routes ?? [],
  ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  blocked: row.blocked,
  addedAt: row.time_created,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const get = Effect.fn("CommunityContacts.get")(function* (networkID: string) {
      const row = yield* db
        .select()
        .from(CommunityContactTable)
        .where(eq(CommunityContactTable.network_id, networkID))
        .get()
        .pipe(Effect.orDie)
      return row === undefined ? undefined : rowContact(row)
    })

    return Service.of({
      get,
      list: Effect.fn("CommunityContacts.list")(function* () {
        const rows = yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie)
        return rows.map(rowContact)
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
          ...(input.routes === undefined ? {} : { routes: [...input.routes] }),
        }
        const insert = db.insert(CommunityContactTable).values({
          network_id: input.networkID,
          ...(input.petname === undefined ? {} : { petname: input.petname }),
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

        const stored = yield* get(input.networkID)
        return stored ?? { networkID: input.networkID, routes: [], blocked: false, addedAt: Date.now() }
      }),

      forget: Effect.fn("CommunityContacts.forget")(function* (networkID: string) {
        const removed = yield* db
          .delete(CommunityContactTable)
          .where(eq(CommunityContactTable.network_id, networkID))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)
        return removed.length > 0
      }),

      setBlocked: Effect.fn("CommunityContacts.setBlocked")(function* (networkID: string, blocked: boolean) {
        const updated = yield* db
          .update(CommunityContactTable)
          .set({ blocked })
          .where(eq(CommunityContactTable.network_id, networkID))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)
        return updated.length > 0
      }),

      observe: Effect.fn("CommunityContacts.observe")(function* (networkID: string, routes: readonly string[]) {
        const updated = yield* db
          .update(CommunityContactTable)
          .set({ routes: [...routes], last_seen_at: Date.now() })
          .where(eq(CommunityContactTable.network_id, networkID))
          .returning({ id: CommunityContactTable.network_id })
          .all()
          .pipe(Effect.orDie)
        // No row updated = we do not know this peer. Not an error, and deliberately not an insert.
        return updated.length > 0
      }),

      bootstrap: Effect.fn("CommunityContacts.bootstrap")(function* () {
        const rows = yield* db.select().from(CommunityContactTable).all().pipe(Effect.orDie)
        return rows
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
