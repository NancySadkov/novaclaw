export * as Credential from "./credential"

import { asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Credential } from "@novaclaw/schema/credential"
import { Integration } from "@novaclaw/schema/integration"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { CredentialTable } from "./credential/sql"
import { CredentialCipher } from "./credential-cipher"

export const ID = Credential.ID
export type ID = Credential.ID

export const OAuth = Credential.OAuth
export type OAuth = Credential.OAuth

export const Key = Credential.Key
export type Key = Credential.Key

export const Value = Credential.Value
export type Value = Credential.Value

export class Info extends Schema.Class<Info>("Credential.Info")({
  id: ID,
  integrationID: Integration.ID,
  label: Schema.String,
  value: Value,
}) {}

export interface Interface {
  /** Returns every stored credential. */
  readonly all: () => Effect.Effect<Info[]>
  /** Returns stored credentials belonging to one integration. */
  readonly list: (integrationID: Integration.ID) => Effect.Effect<Info[]>
  /** Returns one stored credential by ID. */
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  /** Replaces any credential for an integration and returns the new record. */
  readonly create: (input: {
    readonly integrationID: Integration.ID
    readonly value: Value
    readonly label?: string
  }) => Effect.Effect<Info>
  /** Updates the label or secret value of a stored credential. */
  readonly update: (id: ID, updates: Partial<Pick<Info, "label" | "value">>) => Effect.Effect<void>
  /** Removes a stored credential. */
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/Credential") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const cipher = yield* CredentialCipher.Service
    const decode = Schema.decodeUnknownSync(Value)
    const aad = (id: ID) => `novaclaw:credential:${id}`
    const encode = (id: ID, value: Value) => cipher.encrypt(JSON.stringify(value), aad(id))
    const stored = Effect.fn("Credential.stored")(function* (row: typeof CredentialTable.$inferSelect) {
      if (!row.integration_id) return
      const plaintext = cipher.encrypted(row.value) ? yield* cipher.decrypt(row.value, aad(row.id)) : row.value
      const value = decode(JSON.parse(plaintext))
      // Online migration: a valid legacy row becomes encrypted the first time it is read. `all()` is
      // part of catalog boot, so normal startup migrates the whole table without a schema migration or
      // a second plaintext copy. A malformed row fails this credential read, never instance boot.
      if (!cipher.encrypted(row.value))
        yield* db
          .update(CredentialTable)
          .set({ value: encode(row.id, value) })
          .where(eq(CredentialTable.id, row.id))
          .run()
          .pipe(Effect.orDie)
      return new Info({
        id: row.id,
        integrationID: row.integration_id,
        label: row.label,
        value,
      })
    })

    return Service.of({
      all: Effect.fn("Credential.all")(function* () {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, stored).pipe(
          Effect.map((rows) => rows.filter((row): row is Info => row !== undefined)),
          Effect.orDie,
        )
      }),
      list: Effect.fn("Credential.list")(function* (integrationID) {
        const rows = yield* db
          .select()
          .from(CredentialTable)
          .where(eq(CredentialTable.integration_id, integrationID))
          .orderBy(asc(CredentialTable.time_created))
          .all()
          .pipe(Effect.orDie)
        return yield* Effect.forEach(rows, stored).pipe(
          Effect.map((rows) => rows.filter((row): row is Info => row !== undefined)),
          Effect.orDie,
        )
      }),
      get: Effect.fn("Credential.get")(function* (id) {
        const row = yield* db.select().from(CredentialTable).where(eq(CredentialTable.id, id)).get().pipe(Effect.orDie)
        return row ? yield* stored(row).pipe(Effect.orDie) : undefined
      }),
      create: Effect.fn("Credential.create")(function* (input) {
        const credential = new Info({
          id: ID.create(),
          integrationID: input.integrationID,
          label: input.label ?? "default",
          value: input.value,
        })
        yield* db
          .transaction((tx) =>
            Effect.gen(function* () {
              yield* tx
                .delete(CredentialTable)
                .where(eq(CredentialTable.integration_id, credential.integrationID))
                .run()
              yield* tx
                .insert(CredentialTable)
                .values({
                  id: credential.id,
                  integration_id: credential.integrationID,
                  label: credential.label,
                  value: encode(credential.id, credential.value),
                })
                .run()
            }),
          )
          .pipe(Effect.orDie)
        return credential
      }),
      update: Effect.fn("Credential.update")(function* (id, updates) {
        if (!updates.label && !updates.value) return
        const value = updates.value === undefined ? undefined : encode(id, updates.value)
        yield* db
          .update(CredentialTable)
          .set({ label: updates.label, value })
          .where(eq(CredentialTable.id, id))
          .run()
          .pipe(Effect.orDie)
      }),
      remove: Effect.fn("Credential.remove")(function* (id) {
        yield* db.delete(CredentialTable).where(eq(CredentialTable.id, id)).run().pipe(Effect.orDie)
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Database.defaultLayer),
  Layer.provide(CredentialCipher.defaultLayer),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, CredentialCipher.node] })
