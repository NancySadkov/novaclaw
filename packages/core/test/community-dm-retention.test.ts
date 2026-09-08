import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityDirect } from "@novaclaw/core/community/dm"
import { CommunityDirectMessageTable } from "@novaclaw/core/community/dm.sql"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P3 — what the direct-message store REFUSES to grow into.
 *
 * The channel log has had a retention bound since it was written. The DM store had none, behind the
 * same unauthenticated door, and that asymmetry is the whole finding: proof-of-work meters the RATE
 * a stranger can send at — measured, it drops a flooder from about 9.8k messages a second to 20 —
 * but metering is not a storage bound. Twenty a second at 8 KiB is still gigabytes a day.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node, CommunityDirect.node]),
  ),
)

const identity = (fill: number) => `nid_${Buffer.alloc(32, fill).toString("base64url")}`

/** A stranger's key derived from an index, so each flooded row looks like a distinct sender. */
const stranger = (index: number) => {
  const key = Buffer.alloc(32)
  key.writeUInt32BE(index + 1, 0)
  return `nid_${key.toString("base64url")}`
}

describe("CommunityDirect retention", () => {
  it.effect("🔴 a flood is BOUNDED, and cannot push out the conversation the user cares about", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const contacts = yield* CommunityContacts.Service
      const direct = yield* CommunityDirect.Service
      const store = yield* InstanceIdentityStore.Service

      const friend = identity(1)
      yield* contacts.add({ networkID: friend, petname: "a real friend" }).pipe(Effect.orDie)

      // The message that must survive — and it is the OLDEST thing here, so recency alone would
      // choose to discard it.
      yield* db
        .insert(CommunityDirectMessageTable)
        .values({
          id: "the-one-that-matters",
          peer: friend,
          direction: "in",
          body: "the message that must survive",
          claimed_at: 1,
          received_at: 1,
          signature: "x",
        })
        .run()
        .pipe(Effect.orDie)

      // ⚠️ Every flooded row comes from a DIFFERENT key, which is why a per-conversation cap would
      // not have closed this: each thread stays under any per-thread limit while the total grows
      // without end. Minting a key is free; the bound has to be global.
      const flood = CommunityDirect.MAX_DIRECT_MESSAGES + CommunityDirect.PRUNE_SLACK + 200
      for (let start = 0; start < flood; start += 500) {
        const rows = Array.from({ length: Math.min(500, flood - start) }, (_, offset) => {
          const index = start + offset
          return {
            id: `flood-${index}`,
            peer: stranger(index),
            direction: "in" as const,
            body: "spam",
            claimed_at: 1000 + index,
            received_at: 1000 + index,
            signature: "x",
          }
        })
        yield* db.insert(CommunityDirectMessageTable).values(rows).run().pipe(Effect.orDie)
      }

      // One real message through the real door, which is what trims the store.
      const sealing = yield* store.sealingKey()
      const me = (yield* store.identity()).networkID
      const composed = yield* direct.compose({
        to: me,
        sealingKey: sealing.publicKey,
        sealingSignature: sealing.signature,
        body: "a note to self",
      })
      expect("stored" in composed).toBe(true)

      const total = yield* db.$count(CommunityDirectMessageTable).pipe(Effect.orDie)
      expect(total).toBeLessThanOrEqual(CommunityDirect.MAX_DIRECT_MESSAGES)

      /**
       * 🔴 The eviction ORDER, which matters more than the number. A bound that discarded real mail
       * to make room for spam would hand the attacker exactly what they came for — the flood would
       * still work, it would just cost disk instead of memory.
       */
      const kept = yield* direct.history(friend)
      expect(kept.map((message) => message.body)).toEqual(["the message that must survive"])

      // ⚠️ And the flood is what actually went: this must not pass by having deleted everything.
      expect(total).toBeGreaterThan(CommunityDirect.MAX_DIRECT_MESSAGES / 2)
    }).pipe(),
  )

  it.effect("🔴 the conversation list is ordered by RECENCY, not by whatever the engine returns", () =>
    Effect.gen(function* () {
      /**
       * `conversations` backs the user's list of DM threads and had no test and no `ORDER BY`. A
       * `selectDistinct` with no ordering returns whatever the engine finds convenient, so the list
       * could reorder itself between two openings of the same screen with nothing having happened —
       * which a person reads as the app losing their messages.
       *
       * ⚠️ By RECEIVED time, never the author's claimed `at`: sorting on a number the other party
       * chooses would let them pin themselves to the top of somebody's list forever. The channel log
       * and `history` both already refuse that, and this query followed neither.
       */
      const { db } = yield* Database.Service
      const direct = yield* CommunityDirect.Service
      const oldest = identity(1)
      const middle = identity(2)
      const newest = identity(3)

      // Inserted deliberately OUT of order, so a pass cannot come from insertion order alone.
      for (const [peer, at] of [
        [middle, 200],
        [oldest, 100],
        [newest, 300],
      ] as const)
        yield* db
          .insert(CommunityDirectMessageTable)
          .values({
            id: `m-${peer}-${at}`,
            peer,
            direction: "in",
            body: "x",
            claimed_at: 999_999,
            received_at: at,
            signature: "x",
          })
          .run()
          .pipe(Effect.orDie)

      expect(yield* direct.conversations()).toEqual([newest, middle, oldest])

      // ⚠️ A newer message in the OLDEST thread moves it to the top — the list tracks activity
      // rather than when a conversation began.
      yield* db
        .insert(CommunityDirectMessageTable)
        .values({
          id: "m-revive",
          peer: oldest,
          direction: "in",
          body: "x",
          claimed_at: 1,
          received_at: 400,
          signature: "x",
        })
        .run()
        .pipe(Effect.orDie)
      expect(yield* direct.conversations()).toEqual([oldest, newest, middle])

      /**
       * 🔴 And the author's CLAIMED time does not move anything: every row above carries
       * `claimed_at: 999_999` except the last, which claims to be the oldest thing ever sent. If the
       * order tracked that claim, this list would be upside down.
       */
      expect((yield* direct.conversations())[0]).toBe(oldest)
    }).pipe(),
  )
})
