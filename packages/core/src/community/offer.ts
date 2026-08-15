export * as CommunityOffer from "./offer"

import { Context, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { CommunityContacts } from "./contacts"
import { CommunityOfferTable } from "./sql"
import { Database } from "../database/database"
import { InstanceIdentityStore } from "../instance-identity-store"
import { makeGlobalNode } from "../effect/app-node"

/**
 * Community P6 — signed service offers.
 *
 * 🔴 The owner's motivation, in their words: *"these services don't really offer the AI sharing
 * capabilities, where users may offer their model servers for free or for btc."* An offer is one
 * instance saying, in its own signature, "there is a model server here, on these terms".
 *
 * ⚠️ **Signed, so the OFFER travels and the trust does not.** A peer that passes an offer along
 * cannot alter its endpoint or its terms without breaking the signature — which matters precisely
 * because the useful thing to tamper with is where the traffic goes. It is the same property the
 * successor statement has: a fact anyone can check, so passing it on grants nothing.
 *
 * ⚠️ **This is not a promise, and the UI must not read like one.** An offer says what somebody
 * claims to run; nothing here verifies the endpoint exists, that it serves what it says, or that it
 * will still be there in an hour. Reachability and honesty are separate questions from authenticity,
 * and only the last of the three is answered by a signature.
 *
 * ⛔ **No payment.** The ledger says Lightning is LAST and without custody, and it stays unbuilt: a
 * "free or for btc" offer can currently say `btc` in its terms as TEXT, and any settlement happens
 * between two people out of band. Building rails that move money is a different decision with legal
 * weight, and it is not one to take while wiring up an advertisement format.
 */

export interface Terms {
  /** What is on offer. One kind today; the field exists so a second does not need a new envelope. */
  readonly kind: "model-server"
  /** Where it is, as the offerer describes it. Unverified — see the note above. */
  readonly endpoint: string
  /** Model names the offerer claims to serve. */
  readonly models: readonly string[]
  /**
   * How they want to be paid, as FREE TEXT they wrote.
   *
   * ⚠️ Deliberately not an enum and deliberately not a machine-readable amount. An enum would be a
   * payment protocol with no rails behind it, and a number would look like a price this software
   * could enforce. It can enforce nothing: whatever is agreed happens between two people elsewhere.
   */
  readonly price: string
  /**
   * A Lightning address or LNURL the offerer wants paying at — or empty.
   *
   * 🔴 Under the SIGNATURE, and that is the entire reason it is a field rather than more prose in
   * `price`. An intermediary who could rewrite where money goes, while leaving the endpoint intact,
   * has the most profitable edit available in this whole protocol. The endpoint was protected for the
   * same reason and money is the more attractive target.
   *
   * ⛔ It is a STRING that gets displayed and copied. NovaClaw generates no invoice, tracks no
   * balance, counts no usage and settles nothing — the moment it held or routed funds it would be a
   * money transmitter in several jurisdictions, and the pre-launch legal note applies far harder to
   * money than to messages. The user pays from their own wallet, entirely outside this software, or
   * does not.
   */
  readonly payTo: string
}

export interface Unsigned extends Terms {
  /** The offering instance's `nid_…`, filled from its own identity. */
  readonly from: string
  readonly at: number
}

export interface Signed extends Unsigned {
  readonly signature: string
}

/**
 * 🔴 What an offer may contain. Bounds, not preferences — and this one is an AMPLIFIER.
 *
 * An offer is verified on every READ (`known` re-checks each stored offer, because a row edited on
 * disk must not be served as though a peer had signed it). So a peer who signs ONCE over a hundred
 * thousand model names makes this instance hash all of them every time a user opens the screen. They
 * pay a single signature; we pay per view, forever.
 *
 * ⚠️ Enforced in `verify`, so it binds on the way IN and on the way out — an offer already stored by
 * an older build stops being served rather than being trusted because it is on disk.
 */
export const MAX_MODELS = 64
export const MAX_FIELD_BYTES = 512

/**
 * 🔴 How many peers' offers this instance keeps. Its absence was the PRODUCT of two defects that had
 * each already been found and fixed in their own terms — which is why it survived both.
 *
 * The succession store was bounded because statements arrive from keys an attacker mints for free.
 * The offer envelope was bounded because `verify` runs on every READ, so one signature buys a cost
 * we pay forever. Nobody bounded the offer COUNT, and an offer row is keyed on the offerer's
 * identity — so the same free keypair buys a row, and every row is re-verified on every read.
 *
 * ⚠️ Measured: verify costs **46.6 µs** per stored offer, and `GET /api/community/offer` is an
 * unauthenticated peer endpoint with no proof-of-work anywhere on the path. Unbounded that is 2.3 s
 * per free request at 50,000 rows and **23 s at 500,000** — for a request that costs the caller a
 * TCP connection. It is also what draws the user's own Community panel.
 *
 * 500 is the peer table's ceiling, chosen for the same reason: it is far more than a person can read
 * and it bounds a stranger's reach into our CPU. The read then costs 23 ms at worst.
 */
export const MAX_OFFERS = 500

/** Slack, so the trim is amortised rather than run on every offer learned — see `MAX_OFFERS`. */
export const PRUNE_SLACK = 100

const DOMAIN = "novaclaw/community/service-offer/1"
const encoder = new TextEncoder()

/**
 * The exact bytes signed.
 *
 * 🔴 LENGTH-PREFIXED, like every other envelope here. The failure it prevents is specific: without
 * boundaries, an endpoint of `https://a.example/x` with model `y` and one of `https://a.example/xy`
 * with no model produce identical bytes, so a signature over the first would validate the second —
 * and the second sends the user's traffic somewhere they never agreed to.
 */
export const canonicalBytes = (offer: Unsigned): Uint8Array => {
  const parts: Uint8Array[] = []
  const push = (value: string) => {
    const bytes = encoder.encode(value)
    const length = new Uint8Array(4)
    new DataView(length.buffer).setUint32(0, bytes.length, false)
    parts.push(length, bytes)
  }
  push(DOMAIN)
  push(offer.from)
  push(offer.kind)
  push(offer.endpoint)
  push(offer.price)
  // ⚠️ Appended AFTER `price`, so the two are neighbours — which is what the field-boundary test
  // exercises. Inserting it earlier would have invalidated every signature made before it existed.
  push(offer.payTo)
  const at = new Uint8Array(8)
  new DataView(at.buffer).setBigUint64(0, BigInt(Math.trunc(offer.at)), false)
  parts.push(at)
  // ⚠️ The COUNT precedes the list, so a model cannot be added or dropped without changing the bytes.
  const count = new Uint8Array(4)
  new DataView(count.buffer).setUint32(0, offer.models.length, false)
  parts.push(count)
  for (const model of offer.models) push(model)

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Is this offer really from the instance it names? Pure and total — an offer arrives from a peer. */
/**
 * An endpoint we would be willing to point a probe at: absolute, http or https, with a host.
 *
 * `URL` does the parsing so this cannot drift from what the runtime actually resolves. A hand-rolled
 * `startsWith("http")` would wave through `httpx://a.example`; and in the other direction the parse
 * correctly ACCEPTS `http:evil`, which normalises to `http://evil/` and is an ordinary URL written
 * oddly. Both directions matter — a checker that is merely strict rejects legitimate configuration.
 */
export const isServableEndpoint = (endpoint: string): boolean => {
  /**
   * 🔴 ASCII only, and this is the rule that makes the DISPLAYED endpoint the one we dial.
   *
   * The panel shows the raw string; the runtime connects to what `URL` parses. Unicode makes those
   * two different things, measured: `https://\u0455park.example/v1` shows as `spark.example` and
   * resolves to `xn--park-f9d.example`; a fullwidth dot shows as `spark\uFF0Eexample` and resolves to
   * `spark.example`; a zero-width space vanishes entirely. **Every one of those is a URL that reads
   * as one host and reaches another** — which is the whole trick, and no amount of care by the
   * reader defeats it.
   *
   * ⚠️ Not canonicalisation, which was the first idea and was wrong: requiring `url.href === endpoint`
   * also refuses `https://a.example` (no trailing slash) and `http://Spark.Example/v1` (an uppercase
   * host), both of which a person may reasonably type. A rule that rejects honest input to stop a
   * trick is a bad trade when a narrower one exists.
   *
   * The cost is an internationalised domain name, which is refused and told why. For the address of
   * a model server that is a trade worth making.
   */
  // eslint-disable-next-line no-control-regex
  if (!/^[!-~]+$/.test(endpoint)) return false
  try {
    const url = new URL(endpoint)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    if (url.hostname === "") return false
    /**
     * 🔴 No credentials in the URL — the sharpest of these, because it survives every other check.
     * `https://spark.example@evil.example/v1` is already canonical, is pure ASCII, and connects to
     * **evil.example** while reading as `spark.example`. It passed the scheme rule that was written
     * one commit earlier. A model server endpoint never legitimately carries userinfo.
     */
    if (url.username !== "" || url.password !== "") return false
    return true
  } catch {
    return false
  }
}

/**
 * A payment address we are willing to put on someone's clipboard: ASCII, no spaces — or empty,
 * because free is the normal case. See the note at its call site in `verify` for why.
 */
export const isPayableAddress = (payTo: string): boolean => payTo === "" || /^[!-~]+$/.test(payTo)

export const verify = (offer: Signed): boolean => {
  if (typeof offer.signature !== "string" || offer.signature.length === 0) return false
  if (typeof offer.from !== "string" || typeof offer.endpoint !== "string") return false
  if (typeof offer.price !== "string" || offer.kind !== "model-server") return false
  if (typeof offer.payTo !== "string") return false
  if (!Array.isArray(offer.models) || offer.models.some((model) => typeof model !== "string")) return false
  if (!Number.isFinite(offer.at)) return false
  // ⚠️ Sizes BEFORE the signature check, because the signature is the expensive part and its cost
  // grows with exactly these fields. Checking cheap-and-decisive first is the same ordering the
  // message door uses, for the same measured reason.
  if (offer.models.length > MAX_MODELS) return false
  if (offer.models.some((model) => Buffer.byteLength(model, "utf8") > MAX_FIELD_BYTES)) return false
  for (const field of [offer.endpoint, offer.price, offer.payTo, offer.from])
    if (Buffer.byteLength(field, "utf8") > MAX_FIELD_BYTES) return false
  /**
   * 🔴 The endpoint must be an http(s) URL, and until this it was any string up to 512 bytes.
   *
   * An offer is an advertisement for a model SERVER, so nothing else was ever meaningful — but the
   * string does not merely sit on screen. "Use this" prefills the add-model dialog, and that dialog
   * probes through `POST /provider/:id/probe`, which runs **server-side**. So a scheme a stranger
   * chose would decide what the user's own server opens: `file://` reads the disk it runs on.
   *
   * ⚠️ Checked INSIDE `verify` rather than at the door, for the reason the size bounds are — this
   * runs on every read, so an offer stored by an older build stops being SERVED rather than being
   * trusted because it is already on disk.
   *
   * ⚠️ Deliberately NOT an address filter. A LAN model server is a first-class use here — the
   * offline policy exists partly to keep `http://192.168.x.x:8000/v1` reachable while airgapped —
   * so refusing private ranges would break the configuration this feature is FOR. The scheme is the
   * part that is never legitimately anything else.
   */
  if (!isServableEndpoint(offer.endpoint)) return false
  /**
   * 🔴 The payment address is ASCII with no whitespace, or the offer is not served.
   *
   * `payTo` goes to `navigator.clipboard.writeText` verbatim and from there into somebody's wallet,
   * so what the user READS and what they PASTE have to be the same string. Measured, they need not
   * be: a zero-width space inside `nancy@getalby` + `.com` renders as the honest address and copies
   * as a different one, and forty spaces hide a second address off the end of the rendered line. A
   * Cyrillic `a` does not even diverge — it simply reads as the letter it is imitating.
   *
   * ⚠️ Narrow on purpose, like the endpoint rule. Every form this field legitimately takes — a
   * Lightning address, an LNURL, a bolt11 invoice — is ASCII without spaces, so nothing real is
   * refused. `price` next door is deliberately NOT held to this: it is prose a human wrote and may
   * be in any language.
   *
   * An EMPTY `payTo` stays valid: most offers will have none, and free is the normal case.
   */
  if (!isPayableAddress(offer.payTo)) return false
  const signature = Buffer.from(offer.signature, "base64url")
  if (signature.length !== 64) return false
  return InstanceIdentityStore.verifySignature(offer.from, canonicalBytes(offer), signature)
}

/** One row, one instance, one offer. */
const ROW = "self"

export interface Interface {
  /** Publish (or replace) what this instance offers. Signed as it is stored. */
  readonly publish: (terms: Terms) => Effect.Effect<Signed>
  /** Stop offering. */
  readonly withdraw: () => Effect.Effect<void>
  /** What this instance offers, if anything — the thing peers fetch. */
  readonly mine: () => Effect.Effect<Signed | undefined>
  /**
   * Keep an offer collected from a peer.
   *
   * ⚠️ Verified BEFORE storing and again on the way out. An unverified store would let this instance
   * repeat somebody's forged claim about a third party's endpoint — and passing on an offer we did
   * not check is exactly how a rewritten endpoint gets laundered through an honest instance.
   */
  readonly learn: (offer: Signed) => Effect.Effect<boolean>
  /**
   * What WE have stored, servable or not — the owner's own view, which is not the same question as
   * what peers can fetch.
   *
   * 🔴 Exists because the panel used to read the PEER endpoint for this. The intent was good ("show
   * the user their advertisement exactly as others see it") but it couples the owner's truth to the
   * peer door, so every policy on that door silently rewrites what the owner is told. Two ways that
   * bit, both observed on a running instance:
   *
   *   - AIRGAPPED, the peer door answers 503, so the panel could not show the user their own offer.
   *   - a stored offer the CURRENT rules refuse — an endpoint or payment address that an older build
   *     accepted — reads as `{}`, and the panel said "You are not offering anything." The user did
   *     offer something; it simply stopped being servable under an upgrade, silently.
   *
   * `servable` is the difference between those and "nothing published", so the panel can say which.
   */
  readonly mineStored: () => Effect.Effect<{ readonly offer?: Signed; readonly servable: boolean }>

  /** Offers collected from peers — never our own. */
  readonly known: () => Effect.Effect<ReadonlyArray<Signed>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityOffer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const identity = yield* InstanceIdentityStore.Service
    const { db } = yield* Database.Service
    const contacts = yield* CommunityContacts.Service

    return Service.of({
      publish: Effect.fn("CommunityOffer.publish")(function* (terms: Terms) {
        const self = (yield* identity.identity()).networkID
        // ⚠️ `from` comes from OUR identity, never a caller's argument — the same rule the message
        // and DM envelopes hold: a signer that accepts an author will sign someone else's name.
        const unsigned: Unsigned = { ...terms, models: [...terms.models], from: self, at: Date.now() }
        const signature = yield* identity.sign(canonicalBytes(unsigned))
        const signed: Signed = { ...unsigned, signature: signature.toString("base64url") }
        yield* db
          .insert(CommunityOfferTable)
          .values({ id: ROW, document: JSON.stringify(signed) })
          .onConflictDoUpdate({ target: CommunityOfferTable.id, set: { document: JSON.stringify(signed) } })
          .run()
          .pipe(Effect.orDie)
        return signed
      }),

      withdraw: Effect.fn("CommunityOffer.withdraw")(function* () {
        yield* db.delete(CommunityOfferTable).where(eq(CommunityOfferTable.id, ROW)).run().pipe(Effect.orDie)
      }),

      /**
       * What we offer — RE-SIGNED if this instance has rotated since publishing.
       *
       * 🔴 Not withheld, and not served stale. The offer stays cryptographically valid after a
       * rotation (it proves the OLD key made it), so nothing is broken — but a peer would fetch an
       * identity from `/global/health` and a DIFFERENT one from the offer, which reads as somebody
       * else's advertisement rather than as this instance's. Withholding it would be worse still:
       * rotation exists precisely so relationships survive a key change, and an offer that vanished
       * when the user rotated would contradict the feature it depends on.
       *
       * ⚠️ Lazy, like the sealing key: it re-signs on the next read rather than as part of rotation,
       * because rotation must not need to know about every artefact that quotes the identity.
       */
      learn: Effect.fn("CommunityOffer.learn")(function* (offer: Signed) {
        if (!verify(offer)) return false
        /**
         * 🔴 Blocking applies to advertisements too. Probed live: an instance that had blocked a peer
         * still collected that peer's offer and displayed it to the user — endpoint, models and
         * Lightning address included. An offer is content a stranger wrote, shown in the user's own
         * screen, so "I do not want to hear from this person" has to cover it.
         */
        const contact = yield* contacts.get(offer.from)
        if (contact?.blocked === true) return false
        // ⚠️ Refuses an offer that claims to be OURS. An instance that stored a stranger's offer under
        // its own identity would serve it to everyone as its own, which is the laundering above with
        // one extra step.
        if (offer.from === (yield* identity.identity()).networkID) return false
        if (offer.from === ROW) return false
        yield* db
          .insert(CommunityOfferTable)
          .values({ id: offer.from, document: JSON.stringify(offer) })
          .onConflictDoUpdate({ target: CommunityOfferTable.id, set: { document: JSON.stringify(offer) } })
          .run()
          .pipe(Effect.orDie)

        /**
         * ⚠️ Guarded by a COUNT first, because enforcing a bound runs on the attacker's path too —
         * the lesson the channel prune and the DM store both record.
         *
         * Eviction keeps CONTACTS, then the most recently offered. A bound that discarded the offer
         * a user was about to accept, to make room for a flood, would be the attack succeeding by a
         * different route. `ROW` is our own offer and is never a candidate.
         */
        const held = yield* db.$count(CommunityOfferTable).pipe(Effect.orDie)
        if (held > MAX_OFFERS + PRUNE_SLACK)
          yield* db
            .delete(CommunityOfferTable)
            .where(
              sql`${CommunityOfferTable.id} != ${ROW} AND ${CommunityOfferTable.id} NOT IN (
                SELECT id FROM ${CommunityOfferTable} AS o
                WHERE o.id != ${ROW}
                ORDER BY
                  (SELECT COUNT(*) FROM community_contact c WHERE c.network_id = o.id) DESC,
                  o.time_updated DESC,
                  o.rowid DESC
                LIMIT ${MAX_OFFERS}
              )`,
            )
            .run()
            .pipe(Effect.orDie)
        return true
      }),

      known: Effect.fn("CommunityOffer.known")(function* () {
        const rows = yield* db.select().from(CommunityOfferTable).all().pipe(Effect.orDie)
        const out: Signed[] = []
        for (const row of rows) {
          if (row.id === ROW) continue
          try {
            const parsed = JSON.parse(row.document) as Signed
            // Re-verified on READ as well: a row edited on disk must not be handed to a user as
            // though a peer had signed it.
            if (verify(parsed) && parsed.from === row.id) out.push(parsed)
          } catch {
            /* a corrupted row is not an offer */
          }
        }
        return out
      }),

      mineStored: Effect.fn("CommunityOffer.mineStored")(function* () {
        const row = yield* db
          .select()
          .from(CommunityOfferTable)
          .where(eq(CommunityOfferTable.id, ROW))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return { servable: false }
        try {
          const parsed = JSON.parse(row.document) as Signed
          // ⚠️ Reported, not repaired. The endpoint is the user's to choose and we cannot invent a
          // valid one — so this hands them the fact and the existing form fixes it in one action,
          // which is the shape decisions §4 asks for.
          return { offer: parsed, servable: verify(parsed) }
        } catch {
          return { servable: false }
        }
      }),

      mine: Effect.fn("CommunityOffer.mine")(function* () {
        const row = yield* db
          .select()
          .from(CommunityOfferTable)
          .where(eq(CommunityOfferTable.id, ROW))
          .get()
          .pipe(Effect.orDie)
        if (row === undefined) return undefined
        try {
          const parsed = JSON.parse(row.document) as Signed
          // Re-verified on the way OUT rather than trusted because we stored it: a corrupted row must
          // not be advertised to the network as though we had signed it.
          if (!verify(parsed)) return undefined

          const self = (yield* identity.identity()).networkID
          if (parsed.from === self) return parsed

          const unsigned: Unsigned = {
            kind: parsed.kind,
            endpoint: parsed.endpoint,
            models: [...parsed.models],
            price: parsed.price,
            payTo: parsed.payTo,
            from: self,
            at: Date.now(),
          }
          const signature = yield* identity.sign(canonicalBytes(unsigned))
          const resigned: Signed = { ...unsigned, signature: signature.toString("base64url") }
          yield* db
            .update(CommunityOfferTable)
            .set({ document: JSON.stringify(resigned) })
            .where(eq(CommunityOfferTable.id, ROW))
            .run()
            .pipe(Effect.orDie)
          return resigned
        } catch {
          return undefined
        }
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, InstanceIdentityStore.node, CommunityContacts.node],
})
