import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@novaclaw/core/credential"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { CredentialTable } from "@novaclaw/core/credential/sql"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Integration } from "@novaclaw/core/integration"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, Credential.node])))

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
      expect(stored?.value).toStartWith("nc1:")
      expect(stored?.value).not.toContain("secret")
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

  it.effect("migrates a legacy plaintext row when it is first read", () =>
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
      const migrated = yield* db.select({ value: CredentialTable.value }).from(CredentialTable).get()
      expect(migrated?.value).toStartWith("nc1:")
      expect(migrated?.value).not.toContain("plaintext-legacy-secret")
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
