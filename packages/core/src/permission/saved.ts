export * as PermissionSaved from "./saved"

import { eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { PermissionTable } from "./sql"
import { PermissionSaved } from "@novaclaw/schema/permission-saved"

export const ID = PermissionSaved.ID
export type ID = typeof ID.Type

export const Info = PermissionSaved.Info
export type Info = typeof Info.Type

export const ListInput = Schema.Struct({
  origin: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "PermissionSaved.ListInput" })
export type ListInput = typeof ListInput.Type

export const AddInput = Schema.Struct({
  origin: Schema.String,
  action: Schema.String,
  resources: Schema.Array(Schema.String),
  /** 1K: persistent denies. Omitted = "allow" (legacy rows have no effect column). */
  effect: Schema.optional(Schema.Literals(["allow", "deny"])),
}).annotate({ identifier: "PermissionSaved.AddInput" })
export type AddInput = typeof AddInput.Type

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<ReadonlyArray<Info>>
  readonly add: (input: AddInput) => Effect.Effect<void>
  readonly remove: (id: ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/PermissionSaved") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const list = Effect.fn("PermissionSaved.list")(function* (input?: ListInput) {
      const rows = yield* db
        .select()
        .from(PermissionTable)
        .where(input?.origin ? eq(PermissionTable.origin, input.origin) : undefined)
        .all()
        .pipe(Effect.orDie)
      return rows.map(
        (row): Info => ({
          id: row.id,
          origin: row.origin,
          action: row.action,
          resource: row.resource,
          effect: row.effect ?? "allow",
        }),
      )
    })

    const add = Effect.fn("PermissionSaved.add")(function* (input: AddInput) {
      if (!input.resources.length) return
      yield* db
        .insert(PermissionTable)
        .values(
          input.resources.map((resource) => ({
            id: ID.create(),
            origin: input.origin,
            action: input.action,
            resource,
            effect: input.effect ?? "allow",
          })),
        )
        // A re-save with a different verdict REPLACES the old grant (last decision wins).
        .onConflictDoUpdate({
          target: [PermissionTable.origin, PermissionTable.action, PermissionTable.resource],
          set: { effect: input.effect ?? "allow" },
        })
        .run()
        .pipe(Effect.orDie)
    })

    const remove = Effect.fn("PermissionSaved.remove")(function* (id: ID) {
      yield* db.delete(PermissionTable).where(eq(PermissionTable.id, id)).run().pipe(Effect.orDie)
    })

    return Service.of({ list, add, remove })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(Database.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
