export * as InstanceIdentityStore from "./instance-identity-store"

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto"
import { isNull, or } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { CredentialCipher } from "./credential-cipher"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import * as Id from "./id/id"
import { InstanceIdentityTable } from "./instance-identity/sql"

// Remote-access R7: the instance-wide durable identity. `get()` returns the stored id, minting
// one (`ins_…`) on first read — so every instance has a stable id from its first boot with no
// seed step. Advertised over mDNS and reported by /global/health so clients can recognize the
// SAME instance behind different URLs (mDNS name vs IP vs tunnel).
//
// Community P1 (`todo/community-p2p.md`): that id is a random ULID, which is fine for recognising
// one install across routes and useless the moment a stranger makes the claim — anyone can say
// `ins_x`. So the instance also holds an **Ed25519 keypair**, minted on the same first read, and
// the PUBLIC KEY is its identity to the network. A URL is a route, the ULID is a handle, and only a
// signature is proof.

/** How a public key is written wherever a human or a peer might see one. */
const NETWORK_ID_PREFIX = "nid_"

/** Ed25519 raw key bytes sit inside a fixed DER prefix; slicing it off is exact, not a guess. */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex")
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

const rawPublicKey = (der: Buffer): Buffer => der.subarray(SPKI_PREFIX.length)
const publicKeyFromRaw = (raw: Buffer) =>
  createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" })
const privateKeyFromRaw = (raw: Buffer) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" })

/** `nid_<base64url>` — the string form of a public key. */
export const networkID = (publicKey: Uint8Array): string =>
  `${NETWORK_ID_PREFIX}${Buffer.from(publicKey).toString("base64url")}`

/**
 * Parse a peer's `nid_…` back to raw key bytes, or `undefined` if it is not one.
 *
 * ⚠️ Length is checked, not assumed. `createPublicKey` on a short buffer throws inside whatever call
 * happens to be verifying, which reads as a crash rather than as "that peer sent us nonsense".
 */
export const parseNetworkID = (value: string): Buffer | undefined => {
  if (!value.startsWith(NETWORK_ID_PREFIX)) return undefined
  const raw = Buffer.from(value.slice(NETWORK_ID_PREFIX.length), "base64url")
  return raw.length === 32 ? raw : undefined
}

/** Verify a signature against a peer's network id. Never throws: a bad key is just `false`. */
export const verifySignature = (peer: string, message: Uint8Array, signature: Uint8Array): boolean => {
  const raw = parseNetworkID(peer)
  if (raw === undefined) return false
  try {
    return verify(null, Buffer.from(message), publicKeyFromRaw(raw), Buffer.from(signature))
  } catch {
    return false
  }
}

/**
 * A portable copy of the whole identity — **the secret included**.
 *
 * 🔴 THIS FILE IS THE INSTANCE. Anyone holding it can sign as this peer, in a network with no
 * authority to appeal to and no way to revoke. It is a backup in the same sense a house key is: the
 * point is to keep it, and keeping it badly is the risk.
 *
 * It exists because the alternative is worse. With no registry there is no password reset, so a dead
 * disk without a backup means the identity, its contacts and its history are gone permanently — the
 * "breaks in your hands" failure that `AGENTS.md` says a normal person must never meet.
 */
export interface Backup {
  /** Bumped only when the shape changes; a restore refuses a version it does not know. */
  readonly version: 1
  readonly id: string
  readonly networkID: string
  /** Raw 32-byte Ed25519 seed, base64url. */
  readonly secretKey: string
}

export class RestoreError extends Schema.TaggedErrorClass<RestoreError>()("InstanceIdentityStore.RestoreError", {
  message: Schema.String,
}) {}

export interface Identity {
  /** The local handle, minted once (`ins_…`). What mDNS and /global/health already advertise. */
  readonly id: string
  /** The network identity: `nid_<base64url public key>`. */
  readonly networkID: string
  readonly publicKey: Buffer
}

export interface Interface {
  /** The instance's stable id — minted once on first read, immutable after. */
  readonly get: () => Effect.Effect<string>
  /** The full identity, minting the keypair on first read and backfilling an id that predates it. */
  readonly identity: () => Effect.Effect<Identity>
  /** Sign as this instance. The secret is decrypted per call and never leaves this service. */
  readonly sign: (message: Uint8Array) => Effect.Effect<Buffer>
  /**
   * Export the identity INCLUDING its secret, for backup.
   *
   * ⚠️ Not agent-reachable. Whatever surfaces this must be a deliberate human action behind a
   * consent card — an agent that can call it can exfiltrate the instance.
   */
  readonly backup: () => Effect.Effect<Backup>
  /**
   * Restore a backup onto this instance.
   *
   * ⚠️ `replace` must be passed to overwrite an identity that already exists. Silently replacing one
   * would orphan every contact and channel that knows this peer, which is unrecoverable and looks
   * from the outside exactly like the instance being replaced by an impostor.
   */
  readonly restore: (
    backup: Backup,
    options?: { readonly replace?: boolean },
  ) => Effect.Effect<Identity, RestoreError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/InstanceIdentityStore") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cipher = yield* CredentialCipher.Service

    /** Bound to the row it protects, so ciphertext lifted into another row will not decrypt. */
    const AAD = "instance-identity.secret_key"

    const row = () => db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie)

    /**
     * Mint whatever is missing and return the row.
     *
     * ⚠️ Backfills, rather than assuming id and keypair arrive together: every instance that booted
     * before this change already has a row with an id and no keys, and a `get()` that only handled
     * the empty-table case would have left those instances permanently keyless.
     */
    const ensure = Effect.fn("InstanceIdentityStore.ensure")(function* () {
      const existing = yield* row()
      if (existing?.public_key && existing.secret_key) return existing

      const { publicKey, privateKey } = generateKeyPairSync("ed25519")
      const publicRaw = rawPublicKey(publicKey.export({ type: "spki", format: "der" }) as Buffer)
      const secretRaw = (privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).subarray(PKCS8_PREFIX.length)
      const secret = cipher.encrypt(secretRaw.toString("base64url"), AAD)
      const publicEncoded = publicRaw.toString("base64url")

      if (existing === undefined) {
        const id = Id.create("ins", "ascending")
        // Two concurrent first reads race benignly: the second insert conflicts and the
        // stored winner is re-read — the id stays stable either way.
        yield* db
          .insert(InstanceIdentityTable)
          .values({ id, public_key: publicEncoded, secret_key: secret })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      } else {
        // 🔴 Guarded on the key still being absent, so a racing backfill cannot overwrite the
        // winner's key with the loser's. An instance whose public key changed under it would be a
        // DIFFERENT peer to everyone who had already met it.
        yield* db
          .update(InstanceIdentityTable)
          .set({ public_key: publicEncoded, secret_key: secret })
          .where(or(isNull(InstanceIdentityTable.public_key), isNull(InstanceIdentityTable.secret_key)))
          .run()
          .pipe(Effect.orDie)
      }
      const stored = yield* row()
      return stored ?? { id: "", public_key: publicEncoded, secret_key: secret }
    })

    const identity = Effect.fn("InstanceIdentityStore.identity")(function* () {
      const stored = yield* ensure()
      const publicKey = Buffer.from(stored.public_key ?? "", "base64url")
      return { id: stored.id, networkID: networkID(publicKey), publicKey }
    })

    return Service.of({
      get: Effect.fn("InstanceIdentityStore.get")(function* () {
        const stored = yield* ensure()
        return stored.id
      }),
      identity,
      sign: Effect.fn("InstanceIdentityStore.sign")(function* (message: Uint8Array) {
        const stored = yield* ensure()
        const secret = yield* cipher.decrypt(stored.secret_key ?? "", AAD).pipe(Effect.orDie)
        return sign(null, Buffer.from(message), privateKeyFromRaw(Buffer.from(secret, "base64url")))
      }),
      backup: Effect.fn("InstanceIdentityStore.backup")(function* () {
        const stored = yield* ensure()
        const secret = yield* cipher.decrypt(stored.secret_key ?? "", AAD).pipe(Effect.orDie)
        const publicKey = Buffer.from(stored.public_key ?? "", "base64url")
        return { version: 1, id: stored.id, networkID: networkID(publicKey), secretKey: secret } satisfies Backup
      }),
      restore: Effect.fn("InstanceIdentityStore.restore")(function* (
        backup: Backup,
        options?: { readonly replace?: boolean },
      ) {
        if (backup.version !== 1)
          return yield* new RestoreError({ message: `This backup is version ${backup.version}; this build reads version 1.` })

        const secretRaw = Buffer.from(backup.secretKey ?? "", "base64url")
        if (secretRaw.length !== 32)
          return yield* new RestoreError({ message: "The backup's secret key is not 32 bytes — it is truncated or not a NovaClaw backup." })

        /**
         * 🔴 DERIVE the public key from the secret rather than trusting the file's own `networkID`.
         *
         * The two fields in a backup can disagree — through corruption, or because someone edited the
         * identity they claim while keeping a key they hold. Trusting the label would restore an
         * instance that signs with one key while announcing another: every signature it sends fails
         * verification, and the symptom is "peers ignore me", nowhere near the cause.
         */
        const derived = rawPublicKey(
          createPublicKey(privateKeyFromRaw(secretRaw)).export({ type: "spki", format: "der" }) as Buffer,
        )
        if (networkID(derived) !== backup.networkID)
          return yield* new RestoreError({
            message: "This backup's key does not match the identity it claims; it is corrupt or was edited.",
          })

        const existing = yield* row()
        if (existing?.public_key && options?.replace !== true)
          return yield* new RestoreError({
            message:
              "This instance already has an identity. Restoring would orphan every contact that knows it, so it must be confirmed explicitly.",
          })

        const encrypted = cipher.encrypt(secretRaw.toString("base64url"), AAD)
        const publicEncoded = derived.toString("base64url")
        if (existing === undefined)
          yield* db
            .insert(InstanceIdentityTable)
            .values({ id: backup.id, public_key: publicEncoded, secret_key: encrypted })
            .run()
            .pipe(Effect.orDie)
        else
          yield* db
            .update(InstanceIdentityTable)
            .set({ id: backup.id, public_key: publicEncoded, secret_key: encrypted })
            .run()
            .pipe(Effect.orDie)

        return { id: backup.id, networkID: backup.networkID, publicKey: derived }
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer), Layer.provide(CredentialCipher.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, CredentialCipher.node] })
