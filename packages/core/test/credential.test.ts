import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Credential } from "@novaclaw/core/credential"
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
      expect(stored?.value).toBe(JSON.stringify({ type: "key", key: "secret" }))
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
      expect(after?.value).toBe(JSON.stringify({ type: "key", key: "plaintext-legacy-secret" }))
    }),
  )

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
          value: JSON.stringify({ type: "key", key: 42 }),
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
})
