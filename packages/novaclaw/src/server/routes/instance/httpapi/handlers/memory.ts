import { KbAbsorb } from "@novaclaw/core/kb-graph/absorb"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import { LLMClient } from "@novaclaw/llm"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { Log } from "@novaclaw/schema/log"
import { EffectBridge } from "@/effect/bridge"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { ascending } from "@novaclaw/schema/identifier"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

// Memory handlers — a thin lowering of the HTTP contract onto MemoryClient.Service. The memory engine
// is a server-global (per-process) singleton like the DB, so the service resolves directly from the
// handler context (no location routing). Reads DEGRADE to empty when memory is off/unavailable (the
// viewer shows "nothing remembered", never an error); writes surface a MemoryError as the standard 400.

const csv = (value: string | undefined): string[] | undefined => {
  if (value === undefined) return undefined
  const parts = value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return parts.length ? parts : undefined
}
const truthy = (value: string | undefined) => value === "1" || value === "true"

/** Bound a single ingest request; the 4MB tool cap in characters, roughly. */
const MAX_INGEST_CHARS = 4_000_000

const asBadRequest = <A, R>(effect: Effect.Effect<A, MemoryClient.MemoryError, R>) =>
  effect.pipe(
    Effect.catchTag("MemoryClient.MemoryError", (error) =>
      Effect.fail(new InvalidRequestError({ message: error.reason })),
    ),
  )

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    const bridge = yield* EffectBridge.make()
    const memory = Memory.client(yield* Memory.node.service)

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
          return yield* memory
            .path(ctx.payload.from, ctx.payload.to, ctx.payload.maxHops)
            .pipe(Effect.orElseSucceed(() => null))
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
        "ingest",
        Effect.fn("MemoryHttpApi.ingest")(function* (ctx) {
          // Takes document TEXT rather than a path: the caller may be a remote UI with no filesystem in
          // common with this instance, and it keeps path/permission concerns out of the memory tier.
          if (ctx.payload.text.length > MAX_INGEST_CHARS)
            return yield* Effect.fail(
              new InvalidRequestError({
                message: `Document is too large to ingest in one request (${MAX_INGEST_CHARS} character limit). Split it and ingest the parts.`,
              }),
            )
          const label = ctx.payload.name.trim() || "document"
          const scope = ctx.payload.scope?.trim() || "global"
          const passages = KbChunk.chunk(KbChunk.stripGutenberg(ctx.payload.text))
          // MEASURED: a duplicate id does NOT fail on the real engine — addMemory succeeds and the row
          // is deduped by primary key. So counting successful calls would report every passage as
          // "stored" on a re-ingest and tell the user we added content we did not. Count the actual
          // delta instead.
          const before = yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))

          /**
           * The document itself is a THING, and every passage is part of it.
           *
           * 🔴 Measured 2026-08-12 before this existed: a real store held 280 nodes and **22 edges**,
           * of which 202 were passages with none at all. Every passage carried `name: <document
           * label>`, so 280 named nodes shared only 63 distinct names ("EDDS rules" ×102) — a wall of
           * identical marks with nothing joining them. Writing the document as an entity and hanging
           * its passages off it turns that wall into one navigable star per document, at zero model
           * cost, because the association was already in the data and was simply discarded.
           *
           * ⚠️ `KbChunk.entityID` is the SAME function conversational extraction uses. That is the
           * point: a thing mentioned in a chat and a document of the same name land on ONE node. Two
           * formulas would mint two, which is the fragmentation the entity layer exists to remove.
           *
           * ⚠️ This does NOT extract entities from passage CONTENT — a monster manual still has no
           * `Siege Crab` node. That needs a model pass per chunk and is the open half of this defect;
           * do not read a connected graph here as evidence that absorption works.
           */
          const documentID = KbChunk.entityID(scope, label)
          yield* memory
            .addMemory({
              id: documentID,
              kind: "entity",
              text: label,
              name: label,
              scope,
              source: "ingest",
              relation: "staged",
            })
            .pipe(Effect.ignore)

          for (const text of passages) {
            const id = KbChunk.passageID(label, text)
            yield* memory
              .addMemory({
                id,
                kind: "passage",
                text,
                name: label,
                scope,
                source: "ingest",
                relation: "staged",
              })
              .pipe(Effect.ignore)
            // After the node, never before: an edge needs both endpoints to exist.
            yield* memory
              .addEdge({ from: id, to: documentID, type: "part_of", scope, source: "ingest" })
              .pipe(Effect.ignore)
          }
          const after = yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))

          /**
           * ABSORB the first `n` passages — read them with a model so they become named entities.
           *
           * ⚠️ **Detached, and deliberately so.** Each passage is a model call; a document is
           * hundreds. Awaiting them here would hold the HTTP request open for minutes and time it
           * out, and the caller does not need the answer — the graph fills as it goes.
           * `bridge.fork` rather than `Effect.fork`: it runs through `Effect.runFork`, detached from
           * the request's scope — a child of that scope is interrupted the moment the response is
           * written, i.e. before it reads its second passage.
           *
           * ⚠️ The model is LOCATION-scoped while this handler is server-global, so the pass runs
           * inside the location's services. Resolving it is `resolveDefault` — there is no session
           * here, and fabricating one would put a made-up session id into diagnostics.
           *
           * Best-effort as a whole: a document that stored fine must not report failure because the
           * model was unreachable. The passages are already saved and re-ingesting resumes.
           */
          const requested = Math.max(0, Math.trunc(ctx.payload.absorb ?? 0))
          const absorbing = Math.min(requested, passages.length)
          if (absorbing > 0) {
            const directory = ctx.query.directory ?? process.cwd()
            bridge.fork(
              Effect.gen(function* () {
              const models = yield* SessionRunnerModel.Service
              const llm = yield* LLMClient.Service
              // ⚠️ BOUNDED. Picking a model reads a catalog and a credential; it does not call the
              // model, so it is fast or it is stuck. Unbounded, a stuck resolve makes the whole
              // detached pass vanish silently — which is exactly how this failed on 2026-08-12:
              // zero entities, zero errors, and no way to tell it from "extracted nothing".
              const model = yield* models
                .resolveDefault()
                .pipe(Effect.timeoutOrElse({ duration: "30 seconds", orElse: () => Effect.die("resolveDefault timed out") }))
              const outcome = yield* KbAbsorb.absorb({
                llm,
                model,
                memory,
                scope,
                passages: passages.slice(0, absorbing).map((text) => ({ id: KbChunk.passageID(label, text), text })),
                limit: absorbing,
              })
              // Detached work MUST report that it finished. Without this, "ran and found nothing"
              // and "never started" look identical from outside.
              return yield* Log.event("kb.absorb.run.done", {
                "kb.passages": outcome.passages,
                "kb.entities": outcome.entities,
              })
              }).pipe(
                Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
                // ⚠️ `LLMClient` is a GLOBAL node, not a location service, so the location context
                // alone does not satisfy it. Asking for it there neither returned nor failed — the
                // fiber reached `SessionRunnerModel.Service` and stopped dead at `LLMClient.Service`:
                // no value, no error, no log. `bridge.fork` casts requirements away
                // (`as Effect<A, E, never>`), so the compiler could not object either. Provided the
                // same way `agent/agent.ts` does it.
                Effect.provide(AppNodeBuilder.build(llmClient)),
                Effect.catchCause((cause) => Log.event("kb.absorb.run.failed", { "kb.cause": Log.fault(cause) })),
              ),
            )
          }

          return {
            stored: Math.max(0, after.total - before.total),
            passages: passages.length,
            ...(absorbing > 0 ? { absorbing } : {}),
          }
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
).pipe(Layer.provide(ServerLocationServiceMap.layer))
