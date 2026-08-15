export * as CommunityOffer from "./offer"

import { Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
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
}

export interface Unsigned extends Terms {
  /** The offering instance's `nid_…`, filled from its own identity. */
  readonly from: string
  readonly at: number
}

export interface Signed extends Unsigned {
  readonly signature: string
}

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
export const verify = (offer: Signed): boolean => {
  if (typeof offer.signature !== "string" || offer.signature.length === 0) return false
  if (typeof offer.from !== "string" || typeof offer.endpoint !== "string") return false
  if (typeof offer.price !== "string" || offer.kind !== "model-server") return false
  if (!Array.isArray(offer.models) || offer.models.some((model) => typeof model !== "string")) return false
  if (!Number.isFinite(offer.at)) return false
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
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityOffer") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const identity = yield* InstanceIdentityStore.Service
    const { db } = yield* Database.Service

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
  deps: [Database.node, InstanceIdentityStore.node],
})
