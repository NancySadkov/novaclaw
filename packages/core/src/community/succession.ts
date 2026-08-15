export * as CommunitySuccession from "./succession"

import { Context, Effect, Layer } from "effect"
import { CommunitySuccessionTable } from "./sql"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P1 — key rotation (`todo/community-p2p.md`).
 *
 * A **successor statement** is the old key saying, in its own signature, "the peer you knew as me is
 * now this other key". It is how a user moves to a new machine, or replaces a key they think is
 * weak, without becoming a stranger to everyone who ever met them.
 *
 * 🔴 IT CANNOT RECOVER A COMPROMISED KEY, and must never be presented as if it could. Whoever holds
 * the secret can issue a successor statement, so an attacker who has stolen the key can migrate the
 * identity exactly as easily as its owner — and faster, since they need not notice the theft first.
 * Rotation is for PLANNED moves. Recovery from theft needs contacts re-verifying out of band, which
 * is a different feature with a human in it.
 */

export interface Statement {
  /** The key being retired — the one that signs. */
  readonly predecessor: string
  /** The key taking over. */
  readonly successor: string
  readonly at: number
  /** Signature by the PREDECESSOR over the canonical bytes. */
  readonly signature: string
}

/**
 * The exact bytes signed, re-exported from the identity store.
 *
 * ⚠️ ONE encoder, deliberately. A second copy here would be a second protocol: it would agree with
 * itself and with no other instance, and the symptom would be signatures that "randomly" fail.
 */
export const canonicalBytes = InstanceIdentityStore.successionBytes

/**
 * Is this statement really signed by the key it retires?
 *
 * Total and pure: a statement arrives from a peer, so every malformed shape is `false` rather than a
 * throw inside whatever is following the chain.
 */
export const verify = (statement: Statement): boolean => {
  if (typeof statement.predecessor !== "string" || typeof statement.successor !== "string") return false
  if (typeof statement.signature !== "string" || !Number.isFinite(statement.at)) return false
  // 🔴 A statement naming itself as its own successor is nonsense that would otherwise verify
  // perfectly: the signature is valid, and following it would leave a contact pointing at a key that
  // never changed while recording a rotation that never happened.
  if (statement.predecessor === statement.successor) return false
  if (InstanceIdentityStore.parseNetworkID(statement.successor) === undefined) return false
  const signature = Buffer.from(statement.signature, "base64url")
  if (signature.length !== 64) return false
  return InstanceIdentityStore.verifySignature(statement.predecessor, canonicalBytes(statement), signature)
}

/**
 * Follow a chain from a key you know to the key it ends at.
 *
 * ⚠️ Each link must be signed by the key the PREVIOUS link handed to, or a stranger could staple
 * their own statement onto a genuine one and capture the identity. A broken or looping chain returns
 * the last key that was actually proven, never a guess.
 */
export const resolve = (from: string, statements: readonly Statement[]): string => {
  let current = from
  const seen = new Set<string>([from])
  for (;;) {
    const next = statements.find((statement) => statement.predecessor === current && verify(statement))
    // A cycle is not merely useless — it is how a chain could be made to spin forever.
    if (next === undefined || seen.has(next.successor)) return current
    seen.add(next.successor)
    current = next.successor
  }
}

/**
 * The statements this instance has seen, and can hand on.
 *
 * 🔴 The half that makes rotation survivable. Pushing a statement reaches whoever happens to be
 * online; keeping it means a peer that was closed can ask later and still find its way to the user's
 * current key instead of holding an identity that answers nothing.
 */
export interface StoreInterface {
  /** Verify and keep. Returns false for a forgery, or for a key that already rotated. */
  readonly remember: (statement: Statement) => Effect.Effect<boolean>
  /** Everything we can hand on — each one self-verifying, so passing it on grants nothing. */
  readonly known: () => Effect.Effect<ReadonlyArray<Statement>>
}

export class Store extends Context.Service<Store, StoreInterface>()("@novaclaw/v2/CommunitySuccessionStore") {}

export const layer = Layer.effect(
  Store,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    return Store.of({
      remember: Effect.fn("CommunitySuccession.remember")(function* (statement: Statement) {
        // ⚠️ Verified BEFORE it is written, not when it is used. An unverified store would hand
        // forgeries to other people on request, which is worse than believing one ourselves.
        if (!verify(statement)) return false
        const inserted = yield* db
          .insert(CommunitySuccessionTable)
          .values({
            network_id: statement.predecessor,
            successor_id: statement.successor,
            claimed_at: statement.at,
            signature: statement.signature,
          })
          // A key rotates once: the first proven chain wins, and a later fork changes nothing.
          .onConflictDoNothing()
          .returning({ id: CommunitySuccessionTable.network_id })
          .all()
          .pipe(Effect.orDie)
        return inserted.length > 0
      }),

      known: Effect.fn("CommunitySuccession.known")(function* () {
        const rows = yield* db.select().from(CommunitySuccessionTable).all().pipe(Effect.orDie)
        return rows.map((row) => ({
          predecessor: row.network_id,
          successor: row.successor_id,
          at: row.claimed_at,
          signature: row.signature,
        }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Store, layer, deps: [Database.node] })
