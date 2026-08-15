import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P6 — signed service offers (`todo/community-p2p.md`).
 *
 * The owner's motivation: *"users may offer their model servers for free or for btc."* What a
 * signature buys here is narrow and worth stating — an offer travels through strangers, so the thing
 * to protect is its ENDPOINT and its TERMS, because those are what an intermediary would profit from
 * changing.
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityOffer.node])),
)

const terms = {
  kind: "model-server",
  endpoint: "https://spark.example:8010/v1",
  models: ["holo3.1", "gemma-4-E4B"],
  price: "free",
  payTo: "nancy@getalby.com",
} as const

describe("CommunityOffer", () => {
  it.effect("an offer is signed as this instance, and comes back verifiable", () =>
    Effect.gen(function* () {
      const offers = yield* CommunityOffer.Service
      const me = (yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))).networkID

      const published = yield* offers.publish(terms)
      expect(published.from).toBe(me)
      expect(CommunityOffer.verify(published)).toBe(true)
      expect(yield* offers.mine()).toEqual(published)

      yield* offers.withdraw()
      expect(yield* offers.mine()).toBeUndefined()
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

  it.effect("🔴 the ENDPOINT cannot be rewritten in flight", () =>
    Effect.gen(function* () {
      /**
       * The attack worth stopping. An offer passes through instances that did not write it, and the
       * profitable edit is not the model list or the price — it is where the traffic goes. A user
       * who accepts a rewritten offer sends their prompts to whoever rewrote it.
       */
      const offers = yield* CommunityOffer.Service
      const published = yield* offers.publish(terms)

      const moved = { ...published, endpoint: "https://attacker.example/v1" }
      expect(CommunityOffer.verify(moved)).toBe(false)
      // The other terms are covered too: a relay must not be able to make somebody's free offer
      // paid, or advertise models they never claimed.
      expect(CommunityOffer.verify({ ...published, price: "0.01 btc per request" })).toBe(false)
      expect(CommunityOffer.verify({ ...published, models: [...published.models, "gpt-9"] })).toBe(false)
      expect(CommunityOffer.verify({ ...published, models: [] })).toBe(false)
      expect(CommunityOffer.verify({ ...published, from: `nid_${Buffer.alloc(32, 4).toString("base64url")}` })).toBe(
        false,
      )
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

  it.effect("🔴 field boundaries are unambiguous — a shifted character breaks it", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ Between ADJACENT fields, and the first version was VACUOUS for missing that. It shifted a
       * character from `endpoint` into `models`, which are not neighbours — `price`, the timestamp
       * and the model count all sit between them — so the bytes differ either way and the test passed
       * with the length prefixes deleted. Caught by deleting them and watching all five tests stay
       * green. (The same mistake was made earlier in this program against the channel envelope; a
       * concatenation test only means something where two fields actually touch.)
       *
       * `endpoint` and `price` ARE neighbours: without prefixes, `…/x` + `free` and `…/xf` + `ree`
       * are the same bytes, so one signature would validate an offer pointing somewhere else.
       */
      const offers = yield* CommunityOffer.Service
      const published = yield* offers.publish({ ...terms, endpoint: "https://a.example/x", price: "free" })
      expect(CommunityOffer.verify(published)).toBe(true)

      const shifted = { ...published, endpoint: "https://a.example/xf", price: "ree" }
      expect(CommunityOffer.verify(shifted)).toBe(false)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

  it.effect("🔴 an offer SURVIVES a rotation, re-signed under the new identity", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ My first version asserted the offer should be WITHHELD after a rotation, and it was wrong
       * in both directions. It is not broken — `verify` checks against the key embedded in the offer,
       * so an offer signed by the old key stays perfectly valid. And withholding it would contradict
       * the feature it depends on: rotation exists so relationships survive a key change, and an
       * advertisement that vanished when the user rotated would be the opposite of that.
       *
       * What is actually wrong is serving it UNCHANGED: a peer would read one identity from
       * `/global/health` and a different one from the offer, which looks like somebody else's.
       */
      const offers = yield* CommunityOffer.Service
      const store = yield* InstanceIdentityStore.Service
      const before = yield* offers.publish(terms)
      const rotated = yield* store.rotate()

      const after = yield* offers.mine()
      expect(after).toBeDefined()
      // Same offer, new signer — matching the identity a peer sees on `/global/health`.
      expect(after?.from).toBe(rotated.identity.networkID)
      expect(after?.from).not.toBe(before.from)
      expect(after?.endpoint).toBe(terms.endpoint)
      expect([...(after?.models ?? [])]).toEqual([...terms.models])
      expect(CommunityOffer.verify(after!)).toBe(true)

      // And it stays put: a second read does not re-sign again, which would churn `at` on every fetch.
      expect(yield* offers.mine()).toEqual(after)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

  it.effect("malformed offers are refused rather than thrown on", () =>
    Effect.gen(function* () {
      const offers = yield* CommunityOffer.Service
      const published = yield* offers.publish(terms)
      for (const broken of [
        { ...published, signature: "" },
        { ...published, signature: "!!!!" },
        { ...published, at: Number.NaN },
        { ...published, models: [1 as unknown as string] },
        { ...published, kind: "something-else" as "model-server" },
      ])
        expect(CommunityOffer.verify(broken)).toBe(false)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

  it.effect("🔴 a forged offer cannot be LAUNDERED through an honest instance", () =>
    Effect.gen(function* () {
      /**
       * The attack collection makes possible. An instance collects offers from peers and serves what
       * it knows — so if it stored whatever it was handed, a peer could give it a forged offer naming
       * a third party's endpoint, and every instance downstream would receive that claim from a
       * source it trusts. The signature is what makes passing an offer along harmless; storing one
       * unverified is what would make it dangerous.
       */
      const offers = yield* CommunityOffer.Service
      const stranger = `nid_${Buffer.alloc(32, 7).toString("base64url")}`

      // A claim about somebody else's endpoint, with no valid signature behind it.
      const forged = {
        kind: "model-server" as const,
        endpoint: "https://attacker.example/v1",
        models: ["holo3.1"],
        price: "free",
        payTo: "attacker@theirdomain.com",
        from: stranger,
        at: Date.now(),
        signature: Buffer.alloc(64, 1).toString("base64url"),
      }
      expect(yield* offers.learn(forged)).toBe(false)
      expect(yield* offers.known()).toEqual([])

      // ⚠️ And a peer cannot plant an offer under OUR identity, which would have us advertising a
      // stranger's endpoint as our own to everyone who asks.
      const me = (yield* InstanceIdentityStore.Service.pipe(Effect.flatMap((s) => s.identity()))).networkID
      const published = yield* offers.publish(terms)
      expect(yield* offers.learn({ ...published, from: me })).toBe(false)
      expect(yield* offers.known()).toEqual([])
      // Our own offer is still ours, and is not listed among the peers'.
      expect((yield* offers.mine())?.from).toBe(me)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )


  it.effect("🔴 the PAYMENT ADDRESS is under the signature — the most profitable edit there is", () =>
    Effect.gen(function* () {
      /**
       * An intermediary who could rewrite where money goes, while leaving the endpoint intact, has the
       * most profitable edit available in this protocol: the victim keeps getting the service they
       * expect and never notices the payments went elsewhere. The endpoint is protected for the same
       * reason and money is the more attractive target, which is why this is a field rather than more
       * prose inside `price`.
       */
      const offers = yield* CommunityOffer.Service
      const published = yield* offers.publish(terms)
      expect(published.payTo).toBe("nancy@getalby.com")
      expect(CommunityOffer.verify(published)).toBe(true)

      expect(CommunityOffer.verify({ ...published, payTo: "attacker@theirdomain.com" })).toBe(false)
      expect(CommunityOffer.verify({ ...published, payTo: "" })).toBe(false)

      // ⚠️ `price` and `payTo` are NEIGHBOURS in the signed bytes, so this is the case a naive
      // concatenation cannot tell apart: a character moved across their boundary.
      const shifted = yield* offers.publish({ ...terms, price: "free", payTo: "x@y.z" })
      expect(CommunityOffer.verify({ ...shifted, price: "freex", payTo: "@y.z" })).toBe(false)

      // An offer with no payment address is ordinary, not broken — most will have none.
      const unpaid = yield* offers.publish({ ...terms, payTo: "" })
      expect(CommunityOffer.verify(unpaid)).toBe(true)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )


  it.effect("🔴 an offer is BOUNDED — it is re-verified on every read", () =>
    Effect.gen(function* () {
      /**
       * The amplifier in this design. `known` re-verifies each stored offer on every read, because a
       * row edited on disk must not be served as though a peer had signed it — so a peer who signs
       * ONCE over a hundred thousand model names makes this instance hash all of them every time a
       * user opens the screen. One signature for them; a cost per view for us, forever.
       */
      const offers = yield* CommunityOffer.Service
      const huge = yield* offers.publish({
        ...terms,
        models: Array.from({ length: CommunityOffer.MAX_MODELS + 1 }, (_, index) => `model-${index}`),
      })
      // Signed by us and still refused: the bound binds on the way OUT too, so an offer stored by an
      // older build stops being served rather than being trusted because it is on disk.
      expect(CommunityOffer.verify(huge)).toBe(false)
      expect(yield* offers.mine()).toBeUndefined()

      // Long fields are refused the same way, whichever one carries the weight.
      const long = "x".repeat(CommunityOffer.MAX_FIELD_BYTES + 1)
      for (const field of ["endpoint", "price", "payTo"] as const) {
        const published = yield* offers.publish({ ...terms, [field]: long })
        expect(CommunityOffer.verify(published)).toBe(false)
      }

      // ⚠️ And an ordinary offer still passes — a bound that refused real ones would be worse than none.
      const normal = yield* offers.publish(terms)
      expect(CommunityOffer.verify(normal)).toBe(true)
    }).pipe(Effect.provide(CredentialCipher.defaultLayer)),
  )

})
