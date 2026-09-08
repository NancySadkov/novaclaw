import { KbAbsorb } from "@novaclaw/core/kb-graph/absorb"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import * as KbIngest from "@novaclaw/core/kb-graph/ingest-plan"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { LLMClient } from "@novaclaw/llm"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { llmClient } from "@novaclaw/core/effect/app-node-platform"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
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
    const scheduler = yield* SessionScheduler.Service

    const bridge = yield* EffectBridge.make()
    const memory = Memory.client(yield* Memory.node.service)

    return (
      handlers
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
                ...(csv(ctx.query.statuses) ? { statuses: csv(ctx.query.statuses)! as never } : {}),
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
              // ⚠️ The degrade keeps a TRUTHFUL slice: `complete` would claim this empty answer is the
              // whole graph. `scan-capped` is the honest shape for "we could not read it", and the app
              // additionally reads the diagnosis board to say WHY (`utils/memory-health.ts`).
              .pipe(
                Effect.orElseSucceed(() => ({
                  nodes: [],
                  edges: [],
                  slice: { partial: true, total: 0, returned: 0, omitted: 0, reason: "scan-capped" as const },
                })),
              )
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
                surface: "http",
              })
              .pipe(Effect.orElseSucceed(() => []))
          }),
        )
        .handle(
          "neighbors",
          Effect.fn("MemoryHttpApi.neighbors")(function* (ctx) {
            return yield* memory
              // ⚠️ OWNER access on the `/memory/*` surface: this is the person's own Memory app, where
              // "what do you remember about me" must be answerable across every scope. It is the one
              // legitimately unrestricted caller, and it says so rather than reaching it by omission —
              // an agent cannot construct this, because its access comes from the session it runs in.
              .neighbors(ctx.payload.id, MemoryAccess.owner(), ctx.payload.k === undefined ? {} : { k: ctx.payload.k })
              .pipe(Effect.orElseSucceed(() => []))
          }),
        )
        .handle(
          "path",
          Effect.fn("MemoryHttpApi.path")(function* (ctx) {
            return yield* memory
              .path(ctx.payload.from, ctx.payload.to, MemoryAccess.owner(), ctx.payload.maxHops)
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
            yield* asBadRequest(memory.invalidate(ctx.payload.id, MemoryAccess.owner()))
            return true
          }),
        )
        .handle(
          "purge",
          Effect.fn("MemoryHttpApi.purge")(function* (ctx) {
            yield* asBadRequest(memory.purge(ctx.payload.id, MemoryAccess.owner()))
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
            // The write PLAN, in the one order that satisfies the endpoint rule — `kb-graph/ingest-plan.ts`
            // holds it, and the reasoning, and is exercised against a real engine rather than grepped.
            const plan = KbIngest.planIngest({
              name: ctx.payload.name,
              text: ctx.payload.text,
              ...(ctx.payload.scope === undefined ? {} : { scope: ctx.payload.scope }),
            })
            const label = plan.document.name ?? "document"
            const scope = plan.document.scope
            const passages = plan.passages.map((passage) => passage.text)
            // MEASURED: a duplicate id does NOT fail on the real engine — addMemory succeeds and the row
            // is deduped by primary key. So counting successful calls would report every passage as
            // "stored" on a re-ingest and tell the user we added content we did not. Count the actual
            // delta instead.
            const before = yield* memory.stats().pipe(Effect.orElseSucceed(() => ({ total: 0, valid: 0 })))

            for (const step of plan.steps) {
              // ⚠️ `Effect.ignore` per step, as before: one unwritable row must not abandon the rest of
              // a document the user already handed us.
              if (step.kind === "memory") yield* memory.addMemory(step.input).pipe(Effect.ignore)
              // SYSTEM: the plan's own `part_of` edges, both endpoints written by the same plan in the
              // same scope, so the engine's derivation is a no-op here — it is spelled anyway, because
              // an argument left out is exactly what NC-SEC-016 was.
              else yield* memory.addEdge(step.input, MemoryAccess.system()).pipe(Effect.ignore)
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
            /**
             * Absorbing is the DEFAULT, and a cap is the opt-out.
             *
             * It shipped the other way round — absent meant "store the chunks and read none of them" —
             * which was my hedge against the per-passage model cost. But a document that is stored and
             * never read is a document with its pages attached, not knowledge: the graph LOOKS
             * populated (302 edges on the owner's corpus) while containing nothing you could ask a
             * question about. Ingesting into memory and not absorbing is the defect this program
             * exists to fix, so it cannot be the default.
             *
             * The cost is bounded where the ruling puts it — off the reply path, per-call reasoning
             * budget, sequential — not by silently reading less of the document than the user gave us.
             * `absorb: 0` is the explicit opt-out for a caller that only wants passages.
             */
            const requested = ctx.payload.absorb === undefined ? passages.length : Math.trunc(ctx.payload.absorb)
            const absorbing = Math.min(Math.max(0, requested), passages.length)
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
                  const model = yield* models.resolveDefault().pipe(
                    Effect.timeoutOrElse({
                      duration: "30 seconds",
                      orElse: () => Effect.die("resolveDefault timed out"),
                    }),
                  )
                  const outcome = yield* SessionScheduler.runMaintenance(
                    scheduler,
                    {
                      ownerID: `memory-absorb:${scope}:${ascending()}`,
                      task: "kb-absorb",
                      // A document has no session placement. The model's stable provider/id pair is
                      // the safe fallback key: it prevents detached batches for the same backend from
                      // bypassing the scheduler, while never falsely sharing unrelated endpoints.
                      deviceKey: `${model.provider}/${model.id}`,
                      concurrency: 1,
                    },
                    KbAbsorb.absorb({
                      llm,
                      model,
                      memory,
                      scope,
                      passages: passages
                        .slice(0, absorbing)
                        .map((text) => ({ id: KbChunk.passageID(label, text), text })),
                      limit: absorbing,
                    }),
                    Effect.succeed({ passages: 0, entities: 0 }),
                  )
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
        /**
         * Delete every memory in one scope. A destructive WRITE — the only one on this surface that
         * takes no id and cannot be narrowed after the fact.
         */
        .handle(
          "clearScope",
          Effect.fn("MemoryHttpApi.clearScope")(function* (ctx) {
            yield* asBadRequest(memory.clearScope(ctx.payload.scope))
            return true
          }),
        )
    )
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
