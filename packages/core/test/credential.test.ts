import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@novaclaw/core/credential"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { CredentialTable } from "@novaclaw/core/credential/sql"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Integration } from "@novaclaw/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, Credential.node, CredentialCipher.node])))

describe("Credential", () => {
  it.effect("stores, updates, lists, and removes credentials", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const integrationID = Integration.ID.make("openai")
      const created = yield* credentials.create({
        integrationID,
        label: "Work",
        value: Credential.Key.make({ type: "key", key: "secret" }),
      })

      expect(yield* credentials.list(integrationID)).toEqual([created])
      const stored = yield* db.select({ value: CredentialTable.value }).from(CredentialTable).get()
      // 🔴 Plaintext, deliberately — see `credential.ts`. This asserted `nc1:` until 2026-08-28;
      // decision §5 of `decisions-v0.2.0.md` says secrets stay plaintext under OS account
      // protection, and it was recorded after the cipher landed unexplained.
      expect(stored?.value).not.toStartWith("nc1:")
      expect(stored?.value).toContain("secret")
      yield* credentials.update(created.id, { label: "Personal" })
      expect((yield* credentials.list(integrationID))[0]?.label).toBe("Personal")

      const replacement = yield* credentials.create({
        integrationID,
        label: "Replacement",
        value: Credential.Key.make({ type: "key", key: "replacement" }),
      })
      expect(yield* credentials.list(integrationID)).toEqual([replacement])

      yield* credentials.remove(replacement.id)
      expect(yield* credentials.list(integrationID)).toEqual([])
    }),
  )

  it.effect("leaves an already-plaintext row alone", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const id = Credential.ID.create()
      const integrationID = Integration.ID.make("legacy-provider")
      yield* db
        .insert(CredentialTable)
        .values({
          id,
          integration_id: integrationID,
          label: "Legacy",
          value: JSON.stringify({ type: "key", key: "plaintext-legacy-secret" }),
        })
        .run()

      expect((yield* credentials.get(id))?.value).toEqual({ type: "key", key: "plaintext-legacy-secret" })
      const after = yield* db.select({ value: CredentialTable.value }).from(CredentialTable).get()
      expect(after?.value).not.toStartWith("nc1:")
      expect(after?.value).toContain("plaintext-legacy-secret")
    }),
  )

  /**
   * 🔴 The DRAIN — the half that makes it safe to stop encrypting.
   *
   * An instance that has been running has ciphertext in this table. If the read had simply stopped
   * opening envelopes, every one of those rows would be unreadable the moment the key went missing.
   * A successfully opened row is written back as plaintext, so the ciphertext leaves while the key
   * is still there.
   *
   * A/B: make `stored` skip the write-back and this fails on the second assertion.
   */
  it.effect("🔴 drains an existing encrypted row to plaintext on read", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const cipher = yield* CredentialCipher.Service
      const { db } = yield* Database.Service
      const id = Credential.ID.create()
      const integrationID = Integration.ID.make("encrypted-provider")
      yield* db
        .insert(CredentialTable)
        .values({
          id,
          integration_id: integrationID,
          label: "Encrypted",
          value: cipher.encrypt(JSON.stringify({ type: "key", key: "was-encrypted" }), `novaclaw:credential:${id}`),
        })
        .run()

      expect((yield* credentials.get(id))?.value).toEqual({ type: "key", key: "was-encrypted" })
      const drained = yield* db.select({ value: CredentialTable.value }).from(CredentialTable).get()
      expect(drained?.value).not.toStartWith("nc1:")
      expect(drained?.value).toContain("was-encrypted")
    }),
  )

  /**
   * 🔴 A credential encrypted under a key that is GONE must not abort startup.
   *
   * `all()` is part of catalog boot and wraps this path in `orDie`, so one unopenable row took the
   * whole instance down — the NC-REL-030 fault in a second place. The comment here even claimed the
   * opposite: "A malformed row fails this credential read, never instance boot."
   *
   * Skipping is also fail-closed: a credential nothing can read authenticates nothing.
   *
   * A/B: drop the `catchCause` in `stored` and this dies instead of returning a list.
   */
  it.effect("🔴 skips an unopenable credential instead of failing the whole read", () =>
    Effect.gen(function* () {
      const credentials = yield* Credential.Service
      const { db } = yield* Database.Service
      const integrationID = Integration.ID.make("mixed-provider")
      const good = yield* credentials.create({
        integrationID,
        label: "Readable",
        value: Credential.Key.make({ type: "key", key: "readable" }),
      })
      yield* db
        .insert(CredentialTable)
        .values({
          id: Credential.ID.create(),
          integration_id: integrationID,
          label: "Unopenable",
          value: "nc1:AAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBBBBBBBB:CCCCCCCCCCCCCCCCCCCCCCCCCC",
        })
        .run()
      yield* db
        .insert(CredentialTable)
        .values({
          id: Credential.ID.create(),
          integration_id: integrationID,
          label: "Malformed",
          value: "{not json",
        })
        .run()

      // The healthy credential still comes back, and the instance is still standing.
      expect(yield* credentials.list(integrationID)).toEqual([good])
    }),
  )

  it.effect("authenticates ciphertext against the credential id", () =>
    Effect.gen(function* () {
      const cipher = CredentialCipher.make(Buffer.alloc(32, 7))
      const envelope = cipher.encrypt('{"type":"key","key":"secret"}', "credential:one")
      expect(yield* cipher.decrypt(envelope, "credential:one")).toContain('"secret"')
      expect(yield* cipher.decrypt(envelope, "credential:two").pipe(Effect.flip)).toBeInstanceOf(
        CredentialCipher.DecryptError,
      )
    }),
  )
})
