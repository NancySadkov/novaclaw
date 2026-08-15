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
})
