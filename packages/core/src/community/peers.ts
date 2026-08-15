export * as CommunityPeers from "./peers"

import { desc, eq, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityContacts } from "./contacts"
import { CommunityPeerTable } from "./sql"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P0 — the routing table peer exchange fills, and the anti-shutdown property in storage.
 *
 * 🔴 The spec states it exactly: *any peer address from any source — the contact list, a pasted
 * address, mDNS on the LAN, a DNS seed — is a complete entry point, because PEER EXCHANGE supplies
 * the rest. There is no list to seize, because there is nothing special about any particular entry.*
 * Without somewhere to put what PX returns, that sentence is false: one address stays one address,
 * and a network that needs our seed list is one we could switch off by deleting it.
 *
 * ⚠️ **A peer is NOT a contact, and this separation is load-bearing.** `CommunityContacts.observe`
 * and `follow` both refuse to create an entry, because *"learning a NEW peer through the same door
 * would let anything that can talk to us insert itself into the address book, which is a trust
 * decision wearing a maintenance disguise."* PX learns addresses from strangers by definition, so it
 * writes HERE — where a row means only "the network might be reachable there" and confers nothing.
 */

export interface Peer {
  readonly networkID: string
  readonly routes: readonly string[]
  readonly lastSeenAt?: number
  readonly source: string
}

/**
 * 🔴 The most peers we keep. A bound, not a preference.
 *
 * This table is filled by strangers describing other strangers, so it is the one store an attacker
 * can grow without holding any key or paying any proof-of-work — they need only answer a PX request
 * with thousands of invented addresses. Unbounded, that is a disk-fill attack with no signature to
 * verify and nothing to block. Eviction is oldest-seen-first, so peers that actually answer survive
 * and invented ones age out.
 */
export const MAX_PEERS = 500

/** How many we hand a peer that asks. Enough to bootstrap from, few enough not to dump the table. */
export const PX_SAMPLE = 32

export interface Interface {
  /** Every peer we might reach, most recently seen first. */
  readonly list: () => Effect.Effect<ReadonlyArray<Peer>>
  /**
   * Record an address for a peer. Additive: routes accumulate rather than replace, because two
   * sources describe the same peer differently (a LAN address and a public one are both true).
   *
   * ⚠️ Refuses our OWN identity and anything that is not a public key. A table that lists this
   * instance would have us gossiping with ourselves, and an id that cannot verify a signature is an
   * entry that will silently never be useful.
   */
  readonly learn: (
    networkID: string,
    routes: readonly string[],
    source?: string,
  ) => Effect.Effect<boolean>
  /** Mark that this peer answered just now — what keeps it alive through eviction. */
  readonly seen: (networkID: string) => Effect.Effect<boolean>
  /**
   * What we offer another instance that asks for peers.
   *
   * ⚠️ BLOCKED contacts are excluded. Blocking is the only power a user has here, and a block that
   * still handed the blocked peer's address to everyone who asked would make this instance a
   * distributor for someone its owner refuses to hear.
   */
  readonly sample: (limit?: number) => Effect.Effect<ReadonlyArray<Peer>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityPeers") {}

const rowPeer = (row: typeof CommunityPeerTable.$inferSelect): Peer => ({
  networkID: row.network_id,
  routes: row.routes ?? [],
  ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
  source: row.source,
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const identity = yield* InstanceIdentityStore.Service
    const contacts = yield* CommunityContacts.Service

    const all = () =>
      db
        .select()
        .from(CommunityPeerTable)
        .orderBy(desc(sql`coalesce(${CommunityPeerTable.last_seen_at}, 0)`), desc(sql`rowid`))
        .all()
        .pipe(Effect.orDie)

    /**
     * Keep the table under its bound, evicting least-recently-seen first.
     *
     * Selects survivors by IDENTITY rather than by a timestamp cutoff — the same lesson the message
     * log learned: a burst of invented peers all arrive with `last_seen_at` null, so a cutoff would
     * match everything or nothing while the table grew past its "bound".
     */
    const evict = () =>
      db
        .delete(CommunityPeerTable)
        .where(
          sql`${CommunityPeerTable.network_id} NOT IN (
            SELECT network_id FROM ${CommunityPeerTable}
            ORDER BY coalesce(last_seen_at, 0) DESC, rowid DESC
            LIMIT ${MAX_PEERS}
          )`,
        )
        .run()
        .pipe(Effect.orDie)

    return Service.of({
      list: Effect.fn("CommunityPeers.list")(function* () {
        return (yield* all()).map(rowPeer)
      }),

      learn: Effect.fn("CommunityPeers.learn")(function* (networkID, routes, source = "px") {
        if (InstanceIdentityStore.parseNetworkID(networkID) === undefined) return false
        // Ourselves: a peer table listing this instance makes it gossip with itself, and every
        // publish would spend a round trip talking into a mirror.
        if (networkID === (yield* identity.identity()).networkID) return false

        const existing = yield* db
          .select()
          .from(CommunityPeerTable)
          .where(eq(CommunityPeerTable.network_id, networkID))
          .get()
          .pipe(Effect.orDie)

        // Additive and de-duplicated: a LAN address and a public address are both true at once, and
        // replacing would make the last source to speak the only one that counts.
        const merged = [...new Set([...(existing?.routes ?? []), ...routes])]
        if (existing === undefined) {
          yield* db
            .insert(CommunityPeerTable)
            .values({ network_id: networkID, routes: merged, source })
            .onConflictDoNothing()
            .run()
            .pipe(Effect.orDie)
          yield* evict()
          return true
        }
        yield* db
          .update(CommunityPeerTable)
          .set({ routes: merged })
          .where(eq(CommunityPeerTable.network_id, networkID))
          .run()
          .pipe(Effect.orDie)
        return merged.length !== (existing.routes ?? []).length
      }),

      seen: Effect.fn("CommunityPeers.seen")(function* (networkID: string) {
        const updated = yield* db
          .update(CommunityPeerTable)
          .set({ last_seen_at: Date.now() })
          .where(eq(CommunityPeerTable.network_id, networkID))
          .returning({ id: CommunityPeerTable.network_id })
          .all()
          .pipe(Effect.orDie)
        return updated.length > 0
      }),

      sample: Effect.fn("CommunityPeers.sample")(function* (limit = PX_SAMPLE) {
        const rows = yield* all()
        const offered: Peer[] = []
        for (const row of rows) {
          if (offered.length >= limit) break
          if (row.routes === null || row.routes.length === 0) continue
          const contact = yield* contacts.get(row.network_id)
          if (contact?.blocked === true) continue
          offered.push(rowPeer(row))
        }
        return offered
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, InstanceIdentityStore.node, CommunityContacts.node],
})
