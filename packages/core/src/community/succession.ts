export * as CommunitySuccession from "./succession"

import { sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { CommunityObservationTable, CommunitySuccessionTable } from "./sql"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P1 — key rotation (`notes/spec/community-p2p.md`).
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
  /**
   * 🔴 Signature by the SUCCESSOR over the same bytes — review 2026-08-17, finding 1.4.
   *
   * The door is `anonymous` on the premise that "a statement is about the sender's OWN key". That
   * was half true: it is equally about the SUCCESSOR's key, and nothing asked that side. Three
   * attacks were run against the real stores with only the predecessor's signature required:
   *
   *   · **block transfer** — a blocked attacker issues `attacker→victim` for a victim we have never
   *     heard of; `contacts.get(victim)` comes back `{petname:"attacker", blocked:true}`, the
   *     victim's next signed post is rejected as blocked, and the address book lists the victim's
   *     key as "attacker (blocked, 1 former key)";
   *   · **dossier smear** — `about(target)` gains the liar's fabricated dealings;
   *   · **reverse laundering** — a fresh key retires ITSELF into a trusted contact, and `about(wolf)`
   *     returns the doorman's record.
   *
   * Requiring both is what makes the statement a claim two parties made rather than one party's
   * assertion about someone else.
   */
  readonly successorSignature: string
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
  if (typeof statement.signature !== "string" || typeof statement.successorSignature !== "string") return false
  /**
   * 🔴 A SAFE, NON-NEGATIVE integer — finding 1.12, and it was a 500 on the wire.
   *
   * `successionBytes` writes this with `writeBigUInt64BE`, which THROWS on a negative or
   * out-of-range value. `Number.isFinite` let `at: -1` through, so an anonymous `POST
   * /api/community/succession` answered **500 UnknownError** (a bad signature answers 200) and wrote
   * a full `Cause.pretty` stack — absolute source paths included — into the owner's log, free and
   * unauthenticated. Worse: after OUR rotate, `sync.successions` calls `remember` on every reachable
   * peer's statements, so one hostile `at:-1` aborted that loop AFTER the key had already changed.
   */
  if (!Number.isSafeInteger(statement.at) || statement.at < 0) return false
  // 🔴 A statement naming itself as its own successor is nonsense that would otherwise verify
  // perfectly: the signature is valid, and following it would leave a contact pointing at a key that
  // never changed while recording a rotation that never happened.
  if (statement.predecessor === statement.successor) return false
  if (InstanceIdentityStore.parseNetworkID(statement.successor) === undefined) return false
  const signature = Buffer.from(statement.signature, "base64url")
  const successorSignature = Buffer.from(statement.successorSignature, "base64url")
  if (signature.length !== 64 || successorSignature.length !== 64) return false
  const bytes = canonicalBytes(statement)
  // BOTH, over the same bytes. The predecessor says "this new key is also me"; the successor says
  // "I accept that name" — and it is the second half that a stranger cannot forge about somebody.
  if (!InstanceIdentityStore.verifySignature(statement.predecessor, bytes, signature)) return false
  return InstanceIdentityStore.verifySignature(statement.successor, bytes, successorSignature)
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
/**
 * 🔴 How many rotations we will remember. A bound, not a preference.
 *
 * The succession door is UNAUTHENTICATED and carries no proof-of-work — deliberately, since a
 * rotation is rare and making people pay to announce one would slow the honest case to protect
 * against a cheap attack. But that leaves a store a stranger can grow for free: generate a keypair,
 * sign a statement retiring it to another key you also generated, POST, repeat. Every one VERIFIES,
 * because they genuinely own the key they are retiring, and every one is a row.
 *
 * Eviction is oldest-first, which is right for this shape: a statement's value is that a peer who was
 * away can still find someone, and the ones worth keeping are the recent rotations people have not
 * caught up with yet.
 */
export const MAX_STATEMENTS = 1_000

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
            successor_signature: statement.successorSignature,
          })
          // A key rotates once: the first proven chain wins, and a later fork changes nothing.
          .onConflictDoNothing()
          .returning({ id: CommunitySuccessionTable.network_id })
          .all()
          .pipe(Effect.orDie)
        if (inserted.length === 0) return false

        /**
         * 🔴 PINNED: a statement about a peer we have DEALT WITH is never evicted.
         *
         * The cap above is sized for gossip — statements we keep so a peer who was offline can still be
         * pointed onward. A statement linking two keys of someone in `community_observation` is not gossip,
         * it is the spine of our own record, and read-time resolution walks it every time standing is asked
         * for.
         *
         * ⚠️ Without this, whitewashing has a second door that costs nothing: rotate once, wait for the
         * cap to push the link out oldest-first, and the record stops attaching to the person who earned it.
         * No fresh face required, which is the attack the design claims to have already answered.
         *
         * ⚠️ Contacts would have hidden it — their chain lives on the contact row and never evicts, so
         * anything tested with a contact passes. The exposure is precisely for peers dealt with but never
         * added, which is the population the ledger exists to cover.
         *
         * ⚠️ The table is therefore bounded by MAX_STATEMENTS + the peers we have observed, and the
         * second term is bounded by our OWN engagement rather than by anything a stranger can drive.
         */
        // ⚠️ Trimmed by IDENTITY, not by a time cutoff — the lesson the message log and the peer table
        // both record: a burst arriving inside one millisecond makes a cutoff match everything or
        // nothing, and the "bound" then deletes zero rows while the table grows.
        yield* db
          .delete(CommunitySuccessionTable)
          .where(
            sql`${CommunitySuccessionTable.network_id} NOT IN (
              SELECT network_id FROM ${CommunitySuccessionTable}
              ORDER BY time_created DESC, rowid DESC
              LIMIT ${MAX_STATEMENTS}
            )
            AND ${CommunitySuccessionTable.network_id} NOT IN (SELECT subject FROM ${CommunityObservationTable})
            AND ${CommunitySuccessionTable.successor_id} NOT IN (SELECT subject FROM ${CommunityObservationTable})`,
          )
          .run()
          .pipe(Effect.orDie)
        return true
      }),

      known: Effect.fn("CommunitySuccession.known")(function* () {
        const rows = yield* db.select().from(CommunitySuccessionTable).all().pipe(Effect.orDie)
        return rows.map((row) => ({
          predecessor: row.network_id,
          successor: row.successor_id,
          at: row.claimed_at,
          signature: row.signature,
          successorSignature: row.successor_signature,
        }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Store, layer, deps: [Database.node] })
