import { DbRegistry } from "@novaclaw/core/db-registry"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

// Registry handlers — thin lowering of the HTTP contract onto the core DbRegistry module.
// RegistryError (unknown table / no editable columns) becomes the API's standard 400 shape.
export const registryHandlers = HttpApiBuilder.group(InstanceHttpApi, "registry", (handlers) =>
  Effect.gen(function* () {
    const mapError = <A, R>(effect: Effect.Effect<A, DbRegistry.RegistryError, R>) =>
      effect.pipe(
        Effect.catchTag("DbRegistry.RegistryError", (error) =>
          Effect.fail(new InvalidRequestError({ message: error.message })),
        ),
      )

    return handlers
      .handle(
        "tables",
        Effect.fn("RegistryHttpApi.tables")(function* () {
          return yield* DbRegistry.tables()
        }),
      )
      .handle(
        "rows",
        Effect.fn("RegistryHttpApi.rows")(function* (ctx) {
          return yield* mapError(
            DbRegistry.rows({ table: ctx.query.table, limit: ctx.query.limit, offset: ctx.query.offset }),
          )
        }),
      )
      .handle(
        "updateRow",
        Effect.fn("RegistryHttpApi.updateRow")(function* (ctx) {
          yield* mapError(
            DbRegistry.updateRow({
              table: ctx.payload.table,
              rowid: ctx.payload.rowid,
              values: ctx.payload.values,
            }),
          )
          return true
        }),
      )
      .handle(
        "insertRow",
        Effect.fn("RegistryHttpApi.insertRow")(function* (ctx) {
          yield* mapError(DbRegistry.insertRow({ table: ctx.payload.table, values: ctx.payload.values }))
          return true
        }),
      )
      .handle(
        "deleteRow",
        Effect.fn("RegistryHttpApi.deleteRow")(function* (ctx) {
          yield* mapError(DbRegistry.deleteRow({ table: ctx.payload.table, rowid: ctx.payload.rowid }))
          return true
        }),
      )
  }),
)
