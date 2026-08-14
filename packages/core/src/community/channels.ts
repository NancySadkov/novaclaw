export * as CommunityChannels from "./channels"

import { createHash } from "node:crypto"
import { and, desc, eq, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityContacts } from "./contacts"
import { CommunityMessage } from "./message"
import { CommunityChannelTable, CommunityMessageTable } from "./channel.sql"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Community P4 — channel subscriptions and the durable log (`todo/community-p2p.md`).
 *
 * The half of a channel that gossip does not provide. Gossip reaches whoever is online; this is what
 * makes a channel readable by someone who was away, and it is why every instance is a partial
 * archive rather than there being a copy to seize.
 */

/** The channel every instance joins by default. Nobody owns the name — see the ledger. */
export const DEFAULT_CHANNEL = "#NovaClaw"

/**
 * How many messages a channel keeps locally.
 *
 * 🔴 A bound, not a preference. Measured 2026-08-14: one hostile peer delivered ~9.8k messages per
 * second to a subscriber. Unbounded retention turns that from a nuisance into a disk-fill attack
 * that outlives the flood itself, and no moderator exists to stop it.
 */
export const RETAIN_PER_CHANNEL = 5_000

export interface Stored extends CommunityMessage.Signed {
  readonly id: string
  /** When THIS instance received it — the only time we can vouch for. */
  readonly receivedAt: number
}

/** Why an incoming message was not stored. Recorded because "nothing appeared" is unreadable. */
export type Rejection = "unverified" | "wrong-channel" | "blocked" | "duplicate" | "not-subscribed"

export interface Interface {
  readonly join: (channel: string) => Effect.Effect<void>
  readonly leave: (channel: string) => Effect.Effect<boolean>
  readonly channels: () => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly muted: boolean }>>
  readonly setMuted: (channel: string, muted: boolean) => Effect.Effect<boolean>
  /**
   * Ingest a message that arrived on `channel`'s topic. Returns the stored row, or why it was not.
   *
   * This is the ONLY door into the log, so every rule about what may be stored lives here rather
   * than being re-derived by each caller.
   */
  readonly record: (
    channel: string,
    message: CommunityMessage.Signed,
  ) => Effect.Effect<{ readonly stored: Stored } | { readonly rejected: Rejection }>
  /** Most recent first, by RECEIVED time. */
  readonly history: (channel: string, limit?: number) => Effect.Effect<ReadonlyArray<Stored>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityChannels") {}

/** Stable across peers: everyone hashing the same message gets the same id, so dedup works. */
export const messageID = (message: CommunityMessage.Signed): string =>
  createHash("sha256").update(CommunityMessage.canonicalBytes(message)).digest("hex")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const contacts = yield* CommunityContacts.Service

    const rowStored = (row: typeof CommunityMessageTable.$inferSelect): Stored => ({
      id: row.id,
      channel: row.channel,
      author: row.author,
      at: row.claimed_at,
      body: row.body,
      signature: row.signature,
      receivedAt: row.received_at,
    })

    const subscribed = (channel: string) =>
      db
        .select()
        .from(CommunityChannelTable)
        .where(eq(CommunityChannelTable.name, channel))
        .get()
        .pipe(Effect.orDie)

    return Service.of({
      join: Effect.fn("CommunityChannels.join")(function* (channel: string) {
        yield* db
          .insert(CommunityChannelTable)
          .values({ name: channel })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }),

      leave: Effect.fn("CommunityChannels.leave")(function* (channel: string) {
        const removed = yield* db
          .delete(CommunityChannelTable)
          .where(eq(CommunityChannelTable.name, channel))
          .returning({ name: CommunityChannelTable.name })
          .all()
          .pipe(Effect.orDie)
        // ⚠️ History SURVIVES leaving. Deleting it would make "leave" a destructive act the user did
        // not ask for, and rejoining would silently show an empty room they know had messages.
        return removed.length > 0
      }),

      channels: Effect.fn("CommunityChannels.channels")(function* () {
        const rows = yield* db.select().from(CommunityChannelTable).all().pipe(Effect.orDie)
        return rows.map((row) => ({ name: row.name, muted: row.muted }))
      }),

      setMuted: Effect.fn("CommunityChannels.setMuted")(function* (channel: string, muted: boolean) {
        const updated = yield* db
          .update(CommunityChannelTable)
          .set({ muted })
          .where(eq(CommunityChannelTable.name, channel))
          .returning({ name: CommunityChannelTable.name })
          .all()
          .pipe(Effect.orDie)
        return updated.length > 0
      }),

      record: Effect.fn("CommunityChannels.record")(function* (channel: string, message: CommunityMessage.Signed) {
        // Order matters: the cheapest and most decisive checks first, and nothing touches the disk
        // until the message has proved it deserves to.
        if ((yield* subscribed(channel)) === undefined) return { rejected: "not-subscribed" as const }
        if (message.channel !== channel) return { rejected: "wrong-channel" as const }
        if (!CommunityMessage.verify(message)) return { rejected: "unverified" as const }

        /**
         * 🔴 A blocked author is dropped at INGRESS, not filtered at read.
         *
         * Storing then hiding would leave a blocked spammer able to fill the disk at the ~9.8k msg/s
         * measured in the flood test — blocking would stop the user seeing it while still paying
         * every cost of receiving it. The trade is that unblocking does not recover what was
         * dropped, which is the right way round: the user asked not to receive this.
         */
        const contact = yield* contacts.get(message.author)
        if (contact?.blocked === true) return { rejected: "blocked" as const }

        const id = messageID(message)
        const receivedAt = Date.now()
        const inserted = yield* db
          .insert(CommunityMessageTable)
          .values({
            id,
            channel,
            author: message.author,
            claimed_at: message.at,
            received_at: receivedAt,
            body: message.body,
            signature: message.signature,
          })
          // The same message arrives from every mesh peer that has it; a duplicate is the normal
          // case, not an error.
          .onConflictDoNothing()
          .returning({ id: CommunityMessageTable.id })
          .all()
          .pipe(Effect.orDie)
        if (inserted.length === 0) return { rejected: "duplicate" as const }

        // Prune past the retention bound, oldest RECEIVED first.
        const cutoff = yield* db
          .select({ received_at: CommunityMessageTable.received_at })
          .from(CommunityMessageTable)
          .where(eq(CommunityMessageTable.channel, channel))
          .orderBy(desc(CommunityMessageTable.received_at))
          .limit(1)
          .offset(RETAIN_PER_CHANNEL - 1)
          .get()
          .pipe(Effect.orDie)
        if (cutoff !== undefined)
          yield* db
            .delete(CommunityMessageTable)
            .where(
              and(
                eq(CommunityMessageTable.channel, channel),
                lt(CommunityMessageTable.received_at, cutoff.received_at),
              ),
            )
            .run()
            .pipe(Effect.orDie)

        return {
          stored: { ...message, id, receivedAt } satisfies Stored,
        }
      }),

      history: Effect.fn("CommunityChannels.history")(function* (channel: string, limit = 200) {
        const rows = yield* db
          .select()
          .from(CommunityMessageTable)
          .where(eq(CommunityMessageTable.channel, channel))
          // ⚠️ By RECEIVED time, never by the author's claim — see the column's note. Sorting by a
          // number the author chooses hands them the top of every reader's view.
          .orderBy(desc(CommunityMessageTable.received_at), desc(sql`rowid`))
          .limit(limit)
          .all()
          .pipe(Effect.orDie)
        return rows.map(rowStored)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, CommunityContacts.node],
})
