import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CredentialRepair } from "@novaclaw/core/credential/repair"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { InstanceIdentityTable } from "@novaclaw/core/instance-identity/sql"
import { testEffect } from "./lib/effect"

/**
 * The unwind of app-managed encryption, for the ONE secret a user cannot re-enter.
 *
 * Decision §5 of `notes/reports/decisions-v0.2.0.md` says secrets stay plaintext under OS account
 * protection, and the unwind it prescribes has four steps: keep decrypt-on-read, stop encrypting,
 * DRAIN the existing envelopes back to plaintext while the key still exists, and only then delete the
 * cipher. Step three is what makes the tolerant read safe rather than merely tolerant — without it a
 * row written by an older build stays an envelope forever, and the day `credential.key` goes missing
 * in a partial restore it becomes unopenable.
 *
 * 🔴 What makes this store the sharp case rather than one more consumer: a provider credential can be
 * pasted again and an OAuth flow rerun, while an Ed25519 identity that will not open is a network
 * identity permanently lost along with every contact's record of it. `AGENTS.md` requires an instance
 * to be restorable by asking an agent — so the one secret with no repair path at all had better be
 * one the health surface can at least SEE.
 *
 * ⚠️ Each case does its reads inside ONE `it.effect`: split across two runtimes they would run
 * against two different in-memory databases.
 */

const it = testEffect(
  LayerNode.compile(LayerNode.group([Database.node, InstanceIdentityStore.node, CredentialCipher.node])),
)

const AAD = "instance-identity.secret_key"
const SEALING_AAD = "instance-identity.sealing_secret_key"

describe("an identity envelope DRAINS to plaintext", () => {
  it.effect("🔴 a pre-unwind row is rewritten as plaintext on the first read, and still signs", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cipher = yield* CredentialCipher.Service
      const store = yield* InstanceIdentityStore.Service

      // Mint through the store, then put the row back the way a build from before the unwind wrote
      // it. That is the fixture: the same key material, sealed.
      const identity = yield* store.identity()
      const plaintext = (yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!.secret_key!
      expect(cipher.encrypted(plaintext)).toBe(false)
      yield* db
        .update(InstanceIdentityTable)
        .set({ secret_key: cipher.encrypt(plaintext, AAD) })
        .run()
        .pipe(Effect.orDie)
      expect(cipher.encrypted((yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!.secret_key!)).toBe(
        true,
      )

      // One ordinary read — not a rotation, not a restore, nothing the user has to know to run.
      expect((yield* store.identity()).networkID).toBe(identity.networkID)

      const after = (yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!.secret_key!
      // 🔴 The ciphertext has LEFT the table while the key that opens it is still present. That is
      // the whole point: the window in which losing `credential.key` costs the identity is closed.
      expect(cipher.encrypted(after)).toBe(false)
      expect(after).toBe(plaintext)

      // And the drained key is the same key — a drain that mangled the secret would be worse than
      // the envelope, because it would look healthy.
      const message = new TextEncoder().encode("after the drain")
      const signature = yield* store.sign(message)
      expect(InstanceIdentityStore.verifySignature(identity.networkID, message, signature)).toBe(true)
    }),
  )

  it.effect("🔴 the SEALING secret drains too — both columns, or half the identity survives", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cipher = yield* CredentialCipher.Service
      const store = yield* InstanceIdentityStore.Service

      const sealing = yield* store.sealingKey()
      const row = () => db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie)
      const secret = (yield* row())!.sealing_secret_key!
      yield* db
        .update(InstanceIdentityTable)
        .set({ sealing_secret_key: cipher.encrypt(secret, SEALING_AAD) })
        .run()
        .pipe(Effect.orDie)

      yield* store.get()
      expect(cipher.encrypted((yield* row())!.sealing_secret_key!)).toBe(false)
      // Unchanged to every caller: same public half, so nothing a peer already fetched goes stale.
      expect((yield* store.sealingKey()).publicKey).toBe(sealing.publicKey)
    }),
  )

  it.effect("the CONTROL: an intact plaintext secret is not touched, and no write happens", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = yield* InstanceIdentityStore.Service
      const before = yield* store.identity()
      const stored = (yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!

      for (let n = 0; n < 3; n++) yield* store.identity()

      const after = (yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!
      expect(after.secret_key).toBe(stored.secret_key)
      expect(after.public_key).toBe(stored.public_key)
      expect((yield* store.identity()).networkID).toBe(before.networkID)
    }),
  )
})

describe("the repair scan can SEE an identity secret it cannot open", () => {
  it.effect("🔴 an unopenable identity secret is reported, by path and never by value", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cipher = yield* CredentialCipher.Service
      const store = yield* InstanceIdentityStore.Service
      yield* store.identity()

      /**
       * ⚠️ The fixture is an envelope sealed under the WRONG AAD, which is the same decrypt failure a
       * missing `credential.key` produces at the one place that matters — `cipher.decrypt` refusing.
       * It is reachable in a test, and the key file is not.
       */
      const stored = (yield* db.select().from(InstanceIdentityTable).get().pipe(Effect.orDie))!
      yield* db
        .update(InstanceIdentityTable)
        .set({ secret_key: cipher.encrypt(stored.secret_key!, "some-other-aad") })
        .run()
        .pipe(Effect.orDie)

      const found = yield* CredentialRepair.scan([InstanceIdentityStore.repairSource(db, cipher)])
      expect(found).toEqual([{ path: "instance-identity:secret_key" }])
      // A notice surface asked unconditionally now renders something instead of a confident zero.
      const notice = CredentialRepair.notice(found, "C:/state")
      expect(notice).toBeDefined()
      expect(notice).toContain("credential.key")
      // It names the secret, never quotes it: the id is not the secret.
      expect(JSON.stringify(found)).not.toContain(stored.secret_key!.slice(0, 12))
    }),
  )

  it.effect("the CONTROL: a healthy instance reports nothing, and a notice renders nothing", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const cipher = yield* CredentialCipher.Service
      const store = yield* InstanceIdentityStore.Service
      // Both secrets present and plaintext — the ordinary state of every instance this build creates.
      yield* store.sealingKey()

      const found = yield* CredentialRepair.scan([InstanceIdentityStore.repairSource(db, cipher)])
      expect(found).toEqual([])
      expect(CredentialRepair.notice(found, "C:/state")).toBeUndefined()
    }),
  )
})
