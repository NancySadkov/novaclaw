import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { CommunitySuccession } from "@novaclaw/core/community/succession"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P3 — the contact list (`notes/spec/community-p2p.md`).
 *
 * The list is the bootstrap set, so these pin the two properties that make the network survive
 * without us: an entry carries ROUTES (a bare key is unroutable — learned by hanging the P0 spike),
 * and the door for repairing a route cannot be used to insert a stranger.
 */

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, CommunityContacts.node])))

/** A syntactically real identity: 32 bytes, the length a public key actually is. */
const identity = (fill: number) => `nid_${Buffer.alloc(32, fill).toString("base64url")}`

describe("CommunityContacts", () => {
  it.effect("🔴 the user's declared TRUST is stored, clamped, and never cleared by accident", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const who = identity(0x51)

      yield* contacts.add({ networkID: who, petname: "the doorman", trust: 4 })
      expect((yield* contacts.get(who))?.trust).toBe(4)

      /**
       * ⚠️ Re-adding must not silently UN-RATE somebody. `blocked` and `last_seen_at` already
       * follow that rule here, and a trust rating is the one field a user typed on purpose.
       */
      yield* contacts.add({ networkID: who, petname: "renamed" })
      expect((yield* contacts.get(who))?.trust).toBe(4)

      /**
       * 🔴 Clamped rather than refused. Only the ORDER of this column is ever read, so a 9 stored
       * as given would outrank every honest 5 forever — but a bad number is a caller's mistake and
       * not a reason to reject somebody's doorman.
       */
      yield* contacts.add({ networkID: who, trust: 9 })
      expect((yield* contacts.get(who))?.trust).toBe(5)
      yield* contacts.add({ networkID: who, trust: -3 })
      expect((yield* contacts.get(who))?.trust).toBe(1)
    }),
  )

  it.effect("⚠️ an UNRATED contact is unrated, not trusted zero", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const who = identity(0x52)

      // The ordinary state of everyone met through peer exchange. Reading absence as "trusted 0"
      // would rank the entire network below one stranger who was typed in once.
      yield* contacts.add({ networkID: who })
      expect((yield* contacts.get(who))?.trust).toBeUndefined()
    }),
  )

  it.effect("a contact keeps its routes, because an id alone cannot be dialled", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const peer = identity(1)
      const added = yield* contacts.add({
        networkID: peer,
        petname: "spark",
        routes: ["/ip4/192.168.178.40/udp/4242/quic-v1"],
      })
      expect(added.networkID).toBe(peer)
      expect(added.routes).toEqual(["/ip4/192.168.178.40/udp/4242/quic-v1"])
      expect(added.blocked).toBe(false)
      expect((yield* contacts.list()).map((c) => c.petname)).toEqual(["spark"])
    }),
  )

  it.effect("🔴 an id that is not a public key is REFUSED", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      // Each of these would be stored happily by a naive text column and then fail every signature
      // check forever — a contact that is silently never trusted.
      for (const bogus of ["alice", "nid_", "nid_!!!!", `nid_${Buffer.alloc(8).toString("base64url")}`]) {
        const error = yield* contacts.add({ networkID: bogus }).pipe(Effect.flip)
        expect(error.message).toContain("Not a network identity")
      }
      expect(yield* contacts.list()).toEqual([])
    }),
  )

  it.effect("🔴 `observe` repairs a KNOWN peer's route and cannot invent a new contact", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const known = identity(2)
      const stranger = identity(3)
      yield* contacts.add({ networkID: known, routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })

      // Repair: the peer moved, and recording that is maintenance an agent may safely do.
      expect(yield* contacts.observe(known, ["/ip4/10.0.0.9/udp/2/quic-v1"])).toBe(true)
      const updated = yield* contacts.get(known)
      expect(updated?.routes).toEqual(["/ip4/10.0.0.9/udp/2/quic-v1"])
      expect(updated?.lastSeenAt).toBeGreaterThan(0)

      // But a stranger talking to us must NOT thereby enter the address book: that is a trust
      // decision wearing a maintenance disguise.
      expect(yield* contacts.observe(stranger, ["/ip4/10.0.0.5/udp/3/quic-v1"])).toBe(false)
      expect(yield* contacts.get(stranger)).toBeUndefined()
    }),
  )

  it.effect("re-adding a known peer updates it without wiping what you knew", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const peer = identity(4)
      yield* contacts.add({ networkID: peer, petname: "old", routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })
      yield* contacts.setBlocked(peer, true)

      yield* contacts.add({ networkID: peer, petname: "new" })
      const stored = yield* contacts.get(peer)
      expect(stored?.petname).toBe("new")
      // 🔴 The block SURVIVES. Someone re-sharing their contact card must not clear the fact that
      // you blocked them — that would make blocking undoable by the blocked party.
      expect(stored?.blocked).toBe(true)
      expect(stored?.routes).toEqual(["/ip4/10.0.0.1/udp/1/quic-v1"])
    }),
  )

  it.effect("🔴 bootstrap excludes the routeless and the blocked", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const usable = identity(5)
      const routeless = identity(6)
      const blocked = identity(7)
      yield* contacts.add({ networkID: usable, routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })
      yield* contacts.add({ networkID: routeless })
      yield* contacts.add({ networkID: blocked, routes: ["/ip4/10.0.0.2/udp/2/quic-v1"] })
      yield* contacts.setBlocked(blocked, true)

      const entries = (yield* contacts.bootstrap()).map((c) => c.networkID)
      // Routeless: an id with nowhere to dial is not an entry point, which is the whole P0 lesson.
      // Blocked: bootstrapping through someone whose messages you refuse would reconnect you to
      // them on every single start.
      expect(entries).toEqual([usable])
    }),
  )

  it.effect("🔴 following a rotation moves the entry and CARRIES THE BLOCK", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const store = yield* InstanceIdentityStore.Service
      const before = (yield* store.identity()).networkID

      yield* contacts.add({ networkID: before, petname: "noisy", routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })
      yield* contacts.setBlocked(before, true)
      // Everything known about them has to survive, and this is the field with no other coverage:
      // it is optional, so losing it looks like "never reached" rather than like a bug.
      yield* contacts.observe(before, ["/ip4/10.0.0.1/udp/1/quic-v1"])
      const seenBefore = (yield* contacts.get(before))?.lastSeenAt
      expect(seenBefore).toBeGreaterThan(0)

      const { statement, identity: after } = yield* store.rotate()
      expect(yield* contacts.follow(statement)).toBe(true)

      // The old key now RESOLVES to them rather than vanishing, and the entry keeps what we knew.
      // It used to be deleted, which un-blocked their backlog — see the channels suite, where the
      // consequence is visible end to end.
      expect((yield* contacts.get(before))?.networkID).toBe(after.networkID)
      const moved = yield* contacts.get(after.networkID)
      expect(moved?.petname).toBe("noisy")
      expect(moved?.routes).toEqual(["/ip4/10.0.0.1/udp/1/quic-v1"])
      // 🔴 THE point: if rotation cleared the block, "rotate your key" would be the standard way
      // back into a channel you were blocked from, and the person who blocked you would never know.
      expect(moved?.blocked).toBe(true)
      expect(moved?.lastSeenAt).toBe(seenBefore)
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("🔴 an unsigned claim, or one about a stranger, moves nothing", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const store = yield* InstanceIdentityStore.Service
      const known = (yield* store.identity()).networkID
      yield* contacts.add({ networkID: known, routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })

      // Forged: the right predecessor, a signature that is not theirs. Exactly how an identity theft
      // would present itself.
      const forged: CommunitySuccession.Statement = {
        predecessor: known,
        successor: `nid_${Buffer.alloc(32, 8).toString("base64url")}`,
        at: Date.now(),
        signature: Buffer.alloc(64).toString("base64url"),
        successorSignature: Buffer.alloc(64).toString("base64url"),
      }
      expect(yield* contacts.follow(forged)).toBe(false)
      expect(yield* contacts.get(known)).toBeDefined()

      // Genuine, but about somebody we have never met: it must not create an entry, or presenting a
      // statement would be a way into the address book.
      const { statement } = yield* store.rotate()
      yield* contacts.forget(known)
      expect(yield* contacts.follow(statement)).toBe(false)
      expect(yield* contacts.list()).toEqual([])
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("🔴 a block survives a LONG chain — rotating repeatedly is not an escape", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const store = yield* InstanceIdentityStore.Service

      /**
       * 🔴 The whitewashing defence, at depth. One rotation is covered above; the attack this file
       * actually has to refuse is rotating REPEATEDLY to shed a history — the literature's name for
       * it is whitewashing, and `notes/spec/honesty-ledger.md` §1(c) leans on this holding, because
       * a reputation that a fresh key sheds is no reputation at all.
       *
       * ⚠️ Depth is the point. A chain that silently truncates, or that splits into one row per key,
       * would pass the single-rotation test above and fail here — and both failures look like the
       * peer simply being unknown, which is indistinguishable from an honest newcomer.
       */
      const original = (yield* store.identity()).networkID
      yield* contacts.add({ networkID: original, petname: "shifty", routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })
      yield* contacts.setBlocked(original, true)

      const keys = [original]
      for (let round = 0; round < 8; round++) {
        const { statement, identity } = yield* store.rotate()
        expect(yield* contacts.follow(statement), `rotation ${round + 1} was not followed`).toBe(true)
        keys.push(identity.networkID)
      }
      const current = keys.at(-1)!

      // ONE person, not eight: a row per key would make each new one an unknown stranger.
      const rows = yield* contacts.list()
      expect(rows.filter((row) => row.blocked)).toHaveLength(1)
      expect(rows[0]!.networkID).toBe(current)

      // EVERY key they ever held still answers with them — the property `get` promises.
      for (const key of keys) expect((yield* contacts.get(key))?.networkID, `${key} stopped resolving`).toBe(current)

      // 🔴 And the block is still on, eight rotations later. If it were not, "rotate until they
      // forget" would be the standard way back in, and nobody would be told.
      expect((yield* contacts.get(current))?.blocked).toBe(true)
      expect((yield* contacts.list())[0]!.formerIDs).toHaveLength(keys.length - 1)
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("🔴 two rotations arriving OUT OF ORDER still land the contact on the current key", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const store = yield* InstanceIdentityStore.Service
      const original = (yield* store.identity()).networkID
      yield* contacts.add({ networkID: original, petname: "wanderer", routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })

      const first = yield* store.rotate()
      const second = yield* store.rotate()

      // Statements come off a gossip mesh in no order at all. Fed the LAST link first, single-step
      // following drops it (predecessor unknown) and never retries — stranding the contact on a key
      // its owner abandoned, while the proof sat in memory already verified.
      expect(yield* contacts.followAll([second.statement, first.statement])).toBe(1)

      const moved = yield* contacts.get(second.identity.networkID)
      expect(moved?.petname).toBe("wanderer")
      expect(moved?.routes).toEqual(["/ip4/10.0.0.1/udp/1/quic-v1"])
      // 🔴 ONE entry per person in the address book — but every key they ever held still resolves to
      // them. A trail of entries would be wrong; forgetting where they have been is a different kind
      // of wrong, and the one that lets a blocked peer's history back in.
      const listed = yield* contacts.list()
      expect(listed.map((c) => c.networkID)).toEqual([second.identity.networkID])
      expect(listed[0]!.formerIDs).toEqual([first.identity.networkID, original])
      for (const old of [original, first.identity.networkID])
        expect((yield* contacts.get(old))?.networkID).toBe(second.identity.networkID)

      // Forgetting takes the whole chain with it: a leftover row would keep resolving to someone the
      // user believes they have removed.
      expect(yield* contacts.forget(original)).toBe(true)
      expect(yield* contacts.get(second.identity.networkID)).toBeUndefined()
      expect(yield* contacts.list()).toEqual([])
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("🔴 a chain with a MISSING link stops at the last proven key", () =>
    Effect.gen(function* () {
      const contacts = yield* CommunityContacts.Service
      const store = yield* InstanceIdentityStore.Service
      const original = (yield* store.identity()).networkID
      yield* contacts.add({ networkID: original, routes: ["/ip4/10.0.0.1/udp/1/quic-v1"] })

      const first = yield* store.rotate()
      const second = yield* store.rotate()
      // Only the SECOND link is known: nothing connects it to the key we hold, so following it would
      // be a guess — and guessing here means pointing a contact at a key nobody proved they own.
      expect(yield* contacts.followAll([second.statement])).toBe(0)
      expect(yield* contacts.get(original)).toBeDefined()

      // Once the missing link turns up, the contact goes all the way to the end in one pass.
      expect(yield* contacts.followAll([second.statement, first.statement])).toBe(1)
      expect(yield* contacts.get(second.identity.networkID)).toBeDefined()
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )

  it.effect("a contact's id round-trips as a verifiable key", () =>
    Effect.gen(function* () {
      // Ties the list back to identity: what is stored is exactly what `verifySignature` consumes,
      // so a stored contact can actually check a message that claims to come from it.
      const contacts = yield* CommunityContacts.Service
      const identity_ = yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))
      yield* contacts.add({ networkID: identity_.networkID, routes: ["/ip4/127.0.0.1/udp/1/quic-v1"] })
      const stored = yield* contacts.get(identity_.networkID)
      expect(InstanceIdentityStore.parseNetworkID(stored!.networkID)).toHaveLength(32)
    }).pipe(Effect.provide(InstanceIdentityStore.defaultLayer)),
  )
})
