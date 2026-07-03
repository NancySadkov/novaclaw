import { Kb } from "@novaclaw/core/kb"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { notFound } from "../errors"

// KB-A handlers — thin lowering of the HTTP contract onto the Kb service. The
// store is global; NotFoundError becomes the API's standard 404 shape.
export const kbHandlers = HttpApiBuilder.group(InstanceHttpApi, "kb", (handlers) =>
  Effect.gen(function* () {
    const kb = yield* Kb.Service

    const mapNotFound = <A, R>(effect: Effect.Effect<A, Kb.NotFoundError, R>) =>
      effect.pipe(Effect.catchTag("Kb.NotFoundError", (error) => Effect.fail(notFound(`Fact not found: ${error.id}`))))

    return handlers
      .handle(
        "stats",
        Effect.fn("KbHttpApi.stats")(function* () {
          return yield* kb.stats()
        }),
      )
      .handle(
        "query",
        Effect.fn("KbHttpApi.query")(function* (ctx) {
          return yield* kb.query({
            subject: ctx.query.subject,
            predicate: ctx.query.predicate,
            object: ctx.query.object,
            relation: ctx.query.relation,
            includeRetracted: ctx.query.includeRetracted === "true",
            limit: ctx.query.limit,
          })
        }),
      )
      .handle(
        "add",
        Effect.fn("KbHttpApi.add")(function* (ctx) {
          return yield* kb.add(ctx.payload)
        }),
      )
      .handle(
        "update",
        Effect.fn("KbHttpApi.update")(function* (ctx) {
          return yield* mapNotFound(kb.update(ctx.params.id, ctx.payload))
        }),
      )
      .handle(
        "retract",
        Effect.fn("KbHttpApi.retract")(function* (ctx) {
          return yield* mapNotFound(kb.retract(ctx.params.id))
        }),
      )
      .handle(
        "populate",
        Effect.fn("KbHttpApi.populate")(function* (ctx) {
          return yield* kb.populate(ctx.payload.facts)
        }),
      )
      .handle(
        "backup",
        Effect.fn("KbHttpApi.backup")(function* () {
          return yield* kb.backup()
        }),
      )
      .handle(
        "clear",
        Effect.fn("KbHttpApi.clear")(function* () {
          return yield* kb.clear()
        }),
      )
  }),
)
