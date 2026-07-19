import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { ascending } from "@novaclaw/schema/identifier"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

// Memory handlers — a thin lowering of the HTTP contract onto MemoryClient.Service. The memory engine
// is a server-global (per-process) singleton like the DB, so the service resolves directly from the
// handler context (no location routing). Reads DEGRADE to empty when memory is off/unavailable (the
// viewer shows "nothing remembered", never an error); writes surface a MemoryError as the standard 400.

const csv = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean)
  return parts.length ? parts : undefined
}
const truthy = (value: string | undefined) => value === "1" || value === "true"

const asBadRequest = <A, R>(effect: Effect.Effect<A, MemoryClient.MemoryError, R>) =>
  effect.pipe(Effect.catchTag("MemoryClient.MemoryError", (error) => Effect.fail(new InvalidRequestError({ message: error.reason }))))

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const memory = yield* MemoryClient.Service

    return handlers
      .handle(
        "stats",
        Effect.fn("MemoryHttpApi.stats")(function* () {
          return yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))
        }),
      )
      .handle(
        "list",
        Effect.fn("MemoryHttpApi.list")(function* (ctx) {
          return yield* memory
            .list({
              ...(csv(ctx.query.scopes) ? { scopes: csv(ctx.query.scopes)! } : {}),
              ...(csv(ctx.query.kinds) ? { kinds: csv(ctx.query.kinds)! as never } : {}),
              ...(truthy(ctx.query.includeInvalid) ? { includeInvalid: true } : {}),
              ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
              ...(ctx.query.offset === undefined ? {} : { offset: ctx.query.offset }),
            })
            .pipe(Effect.orElseSucceed(() => []))
        }),
      )
      .handle(
        "graph",
        Effect.fn("MemoryHttpApi.graph")(function* (ctx) {
          return yield* memory
            .graph({
              ...(csv(ctx.query.scopes) ? { scopes: csv(ctx.query.scopes)! } : {}),
              ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
            })
            .pipe(Effect.orElseSucceed(() => ({ nodes: [], edges: [] })))
        }),
      )
      .handle(
        "search",
        Effect.fn("MemoryHttpApi.search")(function* (ctx) {
          return yield* memory
            .search({
              query: ctx.payload.query,
              ...(ctx.payload.k === undefined ? {} : { k: ctx.payload.k }),
              ...(ctx.payload.scopes ? { scopes: ctx.payload.scopes } : {}),
              ...(ctx.payload.kinds ? { kinds: ctx.payload.kinds as never } : {}),
            })
            .pipe(Effect.orElseSucceed(() => []))
        }),
      )
      .handle(
        "neighbors",
        Effect.fn("MemoryHttpApi.neighbors")(function* (ctx) {
          return yield* memory
            .neighbors(ctx.payload.id, ctx.payload.k === undefined ? {} : { k: ctx.payload.k })
            .pipe(Effect.orElseSucceed(() => []))
        }),
      )
      .handle(
        "path",
        Effect.fn("MemoryHttpApi.path")(function* (ctx) {
          return yield* memory.path(ctx.payload.from, ctx.payload.to, ctx.payload.maxHops).pipe(Effect.orElseSucceed(() => null))
        }),
      )
      .handle(
        "remember",
        Effect.fn("MemoryHttpApi.remember")(function* (ctx) {
          const id = "mem_" + ascending()
          yield* asBadRequest(
            memory.addMemory({
              id,
              kind: (ctx.payload.kind as never) ?? "entity",
              text: ctx.payload.text,
              ...(ctx.payload.name === undefined ? {} : { name: ctx.payload.name }),
              scope: ctx.payload.scope,
              relation: "staged",
            }),
          )
          return { id }
        }),
      )
      .handle(
        "invalidate",
        Effect.fn("MemoryHttpApi.invalidate")(function* (ctx) {
          yield* asBadRequest(memory.invalidate(ctx.payload.id))
          return true
        }),
      )
      .handle(
        "purge",
        Effect.fn("MemoryHttpApi.purge")(function* (ctx) {
          yield* asBadRequest(memory.purge(ctx.payload.id))
          return true
        }),
      )
      .handle(
        "clearScope",
        Effect.fn("MemoryHttpApi.clearScope")(function* (ctx) {
          yield* asBadRequest(memory.clearScope(ctx.payload.scope))
          return true
        }),
      )
  }),
)
