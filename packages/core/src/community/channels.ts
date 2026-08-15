export * as CommunityChannels from "./channels"

import { createHash } from "node:crypto"
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityContacts } from "./contacts"
import { CommunityMessage } from "./message"
import { CommunityTopic } from "./topic"
import { CommunityWork } from "./work"
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

export interface Stored extends CommunityMessage.Proven {
  readonly id: string
  /** When THIS instance received it — the only time we can vouch for. */
  readonly receivedAt: number
}

/** Why an incoming message was not stored. Recorded because "nothing appeared" is unreadable. */
export type Rejection = "unverified" | "unproven" | "wrong-channel" | "blocked" | "duplicate" | "not-subscribed"

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
    message: CommunityMessage.Proven,
  ) => Effect.Effect<{ readonly stored: Stored } | { readonly rejected: Rejection }>
  /**
   * THE INBOUND DOOR for a transport: a message arrived addressed by TOPIC.
   *
   * 🔴 A sidecar is a separate process and cannot call `record` — it knows only a topic id, and a
   * hash cannot be inverted. Resolution therefore happens HERE, against the channels this instance
   * joined, which makes "we are not subscribed" unanswerable rather than merely unchecked.
   *
   * Returns the same verdicts as `record`, plus `unknown-topic` for an id none of our channels
   * hashes to.
   */
  readonly deliver: (
    topic: string,
    message: CommunityMessage.Proven,
  ) => Effect.Effect<{ readonly stored: Stored } | { readonly rejected: Rejection | "unknown-topic" }>
  /** Most recent first, by RECEIVED time. */
  /**
   * Channels we hold MESSAGES for but no longer subscribe to — what leaving leaves behind.
   *
   * 🔴 Exists because of principle 12: leaving keeps the history (deliberately) while removing the
   * only route back to it, so rejoining meant retyping a name from memory. A name the user cannot
   * see is a value they have no way to know, and the room is not gone — we are holding its
   * messages. Discovery of channels we have NEVER seen is a different problem and needs the network;
   * this is the part that is already sitting on disk.
   */
  readonly archived: () => Effect.Effect<ReadonlyArray<{ readonly name: string; readonly messages: number }>>
  readonly history: (channel: string, limit?: number) => Effect.Effect<ReadonlyArray<Stored>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityChannels") {}

/** Stable across peers: everyone hashing the same message gets the same id, so dedup works. */
export const messageID = (message: CommunityMessage.Signed): string =>
  createHash("sha256").update(CommunityMessage.canonicalBytes(message)).digest("hex")

/**
 * Keep only the newest `keep` messages of a channel.
 *
 * 🔴 Selects the survivors by IDENTITY, not by a timestamp cutoff. The first version deleted
 * `received_at < cutoff`, which fails on TIES — and ties are the normal case under exactly the
 * attack this bound exists for: the flood test delivered ~10 messages per millisecond, and a burst
 * landing entirely inside one millisecond makes the cutoff equal to every row's value, so `<`
 * matches nothing and the "bound" deletes zero rows while the table grows without limit.
 *
 * `rowid` breaks the remaining ties, so the survivor set is deterministic rather than whatever
 * order SQLite happened to return.
 *
 * Exported and parameterised because a bound is only real if it has been watched to hold; testing it
 * through `record` alone would need 5,000 signed messages per case.
 */
export const prune = (db: Database.Interface["db"], channel: string, keep: number) =>
  db
    .delete(CommunityMessageTable)
    .where(
      and(
        eq(CommunityMessageTable.channel, channel),
        sql`${CommunityMessageTable.id} NOT IN (
          SELECT id FROM ${CommunityMessageTable}
          WHERE channel = ${channel}
          ORDER BY received_at DESC, rowid DESC
          LIMIT ${keep}
        )`,
      ),
    )
    .run()
    .pipe(Effect.orDie)

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
      nonce: row.nonce,
      receivedAt: row.received_at,
    })

    /**
     * 🔴 Every SPELLING of this room that appears in the log.
     *
     * Messages are stored under the name of the channel row they arrived on, so one room grows a
     * second spelling the moment a user leaves `#recipes` and rejoins as `#Recipes`. Querying the
     * literal name then hides everything written under the other one — messages that are on disk,
     * belong to the room being read, and are reachable from nowhere: not from history, and not from
     * the archive, which excludes by topic precisely because it IS the same room.
     *
     * The canonical form is the room's identity everywhere else (`topic.ts`, `join`, `verifyOn`), so
     * it is the identity here too. Falls back to the name as given, which is what an archived room
     * with no joined counterpart needs.
     */
    const spellingsOf = (channel: string) =>
      Effect.gen(function* () {
        const rows = yield* db
          .selectDistinct({ name: CommunityMessageTable.channel })
          .from(CommunityMessageTable)
          .all()
          .pipe(Effect.orDie)
        const target = CommunityTopic.canonical(channel)
        const found = rows.map((row) => row.name).filter((name) => CommunityTopic.canonical(name) === target)
        return found.length === 0 ? [channel] : found
      })

    /**
     * The name of the JOINED row for this room, whatever spelling was asked for.
     *
     * 🔴 `join`, `history`, `archived` and `verifyOn` all identify a room canonically; `leave` and
     * `setMuted` compared literally, so leaving `#Recipes` while joined as `#recipes` matched no row,
     * changed nothing, and reported `false` — a no-op that looks exactly like "you were not in that
     * channel". Every door into this store now agrees on what a room IS.
     */
    const joinedAs = (channel: string) =>
      Effect.gen(function* () {
        const rows = yield* db.select().from(CommunityChannelTable).all().pipe(Effect.orDie)
        return CommunityTopic.channelFor(
          CommunityTopic.topicOf(channel),
          rows.map((row) => row.name),
        )
      })

    const subscribed = (channel: string) =>
      db
        .select()
        .from(CommunityChannelTable)
        .where(eq(CommunityChannelTable.name, channel))
        .get()
        .pipe(Effect.orDie)

    const record = Effect.fn("CommunityChannels.record")(function* (
      channel: string,
      message: CommunityMessage.Proven,
    ) {
        // Order matters: the cheapest and most decisive checks first, and nothing touches the disk
        // until the message has proved it deserves to.
        if ((yield* subscribed(channel)) === undefined) return { rejected: "not-subscribed" as const }
        /**
         * ⚠️ The channel check is kept SEPARATE from `verifyOn` only to name the two rejections
         * apart — a caller needs to know whether a message was forged or merely misdelivered. The
         * combined `verifyOn` is then used for the verdict itself, so the rule that "a valid
         * signature on another channel's message is not valid HERE" lives in one place rather than
         * being re-derived by every reader of a channel.
         */
        // ⚠️ CANONICAL, like `verifyOn`'s — and it has to be, because it runs FIRST. A literal
        // comparison here would reject a peer who spelled the room differently before the combined
        // check ever ran, which is the same defect one layer earlier.
        if (CommunityTopic.canonical(message.channel) !== CommunityTopic.canonical(channel))
          return { rejected: "wrong-channel" as const }
        if (!CommunityMessage.verifyOn(channel, message)) return { rejected: "unverified" as const }

        /**
         * 🔴 The flood defence, at the one door everything enters by.
         *
         * Measured: peer scoring does NOT stop a flood (it scored the flooder at the cap), so the
         * cost has to be imposed here. Checking is ONE hash whatever the difficulty, so a receiver
         * spends the same trivial amount rejecting a hostile message as accepting an honest one —
         * verification can never itself become the flood.
         */
        if (!CommunityWork.verify(message.signature, message.nonce)) return { rejected: "unproven" as const }

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
            nonce: message.nonce,
          })
          // The same message arrives from every mesh peer that has it; a duplicate is the normal
          // case, not an error.
          .onConflictDoNothing()
          .returning({ id: CommunityMessageTable.id })
          .all()
          .pipe(Effect.orDie)
        if (inserted.length === 0) return { rejected: "duplicate" as const }

        yield* prune(db, channel, RETAIN_PER_CHANNEL)

        return {
          stored: { ...message, id, receivedAt } satisfies Stored,
        }
    })

    return Service.of({
      join: Effect.fn("CommunityChannels.join")(function* (channel: string) {
        /**
         * 🔴 One row per TOPIC, not per spelling. `onConflictDoNothing` keys on the literal name, so
         * joining `#Recipes` while already in `#recipes` used to add a SECOND row — two entries in
         * the user's channel list that are one room on the network. Delivery resolves a topic to
         * whichever spelling it finds first, so the other would sit there permanently empty while
         * looking perfectly correct, which is precisely the failure the canonical form exists to
         * prevent (see `topic.ts`).
         *
         * The spelling ALREADY JOINED wins: renaming a room under the user because they typed it
         * differently the second time would be a stranger outcome than keeping what they first saw.
         */
        const joined = yield* db.select().from(CommunityChannelTable).all().pipe(Effect.orDie)
        if (CommunityTopic.channelFor(CommunityTopic.topicOf(channel), joined.map((row) => row.name)) !== undefined)
          return
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
          .where(eq(CommunityChannelTable.name, (yield* joinedAs(channel)) ?? channel))
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
          .where(eq(CommunityChannelTable.name, (yield* joinedAs(channel)) ?? channel))
          .returning({ name: CommunityChannelTable.name })
          .all()
          .pipe(Effect.orDie)
        return updated.length > 0
      }),

      record,
            deliver: Effect.fn("CommunityChannels.deliver")(function* (
        topic: string,
        message: CommunityMessage.Proven,
      ) {
        const rows = yield* db.select().from(CommunityChannelTable).all().pipe(Effect.orDie)
        const channel = CommunityTopic.channelFor(
          topic,
          rows.map((row) => row.name),
        )
        // Not a lookup failure to retry: a hash cannot be inverted, so this is the definitive answer
        // that nothing we subscribe to has that id.
        if (channel === undefined) return { rejected: "unknown-topic" as const }
        return yield* record(channel, message)
      }),

      archived: Effect.fn("CommunityChannels.archived")(function* () {
        const counts = yield* db
          .select({
            name: CommunityMessageTable.channel,
            messages: sql<number>`count(*)`,
            latest: sql<number>`max(${CommunityMessageTable.received_at})`,
          })
          .from(CommunityMessageTable)
          .groupBy(CommunityMessageTable.channel)
          .all()
          .pipe(Effect.orDie)
        const joined = (yield* db.select().from(CommunityChannelTable).all().pipe(Effect.orDie)).map(
          (row) => row.name,
        )
        // ⚠️ Excluded by TOPIC, not by name. A user who left `#recipes` and rejoined as `#Recipes` is
        // in that room right now; listing their own history as something to "rejoin" would offer them
        // a door into the room they are standing in.
        // ⚠️ Collapsed by TOPIC, so a room that grew two spellings is ONE entry with ONE total
        // rather than two rooms the user never made.
        //
        // The name shown is the MOST RECENTLY used spelling — what the user last called the room, and
        // so what they will recognise. Taking whichever the grouping returned first would pick by
        // SQLite's collation, which is nothing to do with them.
        const rooms = new Map<string, { name: string; messages: number; latest: number }>()
        for (const entry of counts) {
          if (CommunityTopic.channelFor(CommunityTopic.topicOf(entry.name), joined) !== undefined) continue
          const key = CommunityTopic.canonical(entry.name)
          const existing = rooms.get(key)
          const latest = Number(entry.latest)
          rooms.set(key, {
            name: existing === undefined || latest > existing.latest ? entry.name : existing.name,
            messages: (existing?.messages ?? 0) + Number(entry.messages),
            latest: Math.max(existing?.latest ?? 0, latest),
          })
        }
        return [...rooms.values()].map(({ name, messages }) => ({ name, messages }))
      }),

      history: Effect.fn("CommunityChannels.history")(function* (channel: string, limit = 200) {
        const rows = yield* db
          .select()
          .from(CommunityMessageTable)
          .where(inArray(CommunityMessageTable.channel, yield* spellingsOf(channel)))
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
