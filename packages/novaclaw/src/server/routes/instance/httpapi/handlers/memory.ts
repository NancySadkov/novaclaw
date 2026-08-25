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
import { Log } from "@novaclaw/schema/log"
import { EffectBridge } from "@/effect/bridge"
import { Database } from "@novaclaw/core/database/database"
import { MemoryAccessLedger } from "@novaclaw/core/kb-graph/access-ledger"
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

/** The ledger's verdict, on the wire. Named once so every noise view answers with the same shape. */
const counts = (usage: MemoryAccessLedger.Usage) => ({
  accesses: usage.accesses,
  uses: usage.uses,
  useful: usage.useful,
  corrections: usage.corrections,
  firstAccessedAt: usage.firstAccessedAt,
  lastAccessedAt: usage.lastAccessedAt,
})

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
    /**
     * The P3 access ledger lives in the instance database, beside the store rather than inside it.
     *
     * ⚠️ Resolved HERE, in the group's build, and captured — not read per request. The handler
     * effects run with the request's context, which is not this one; a service read inside them is
     * the shape that made every `memory.*` event a silent no-op in the `kb` tool (see
     * `kb-graph/memory-observed.ts`).
     */
    const { db } = yield* Database.Service

    /**
     * Hydrate the memories behind a set of ledger rollups, keeping the verdict beside each row.
     *
     * ⚠️ A rollup whose memory is GONE simply drops out — `byIds` skips ids it cannot find rather
     * than faking a row. That is the honest answer: the ledger is a record of what recall did, and a
     * memory that has since been invalidated is not something a noise view should offer to act on.
     */
    const withUsage = (usage: ReadonlyArray<MemoryAccessLedger.Usage>) =>
      Effect.gen(function* () {
        const rows = yield* memory.byIds(usage.map((row) => row.memoryID)).pipe(Effect.orElseSucceed(() => []))
        const byID = new Map(usage.map((row) => [row.memoryID, row] as const))
        return rows.map((row) => {
          const found = byID.get(row.id)
          return found === undefined ? row : { ...row, usage: counts(found) }
        })
      })

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
                  const outcome = yield* KbAbsorb.absorb({
                    llm,
                    model,
                    memory,
                    scope,
                    passages: passages
                      .slice(0, absorbing)
                      .map((text) => ({ id: KbChunk.passageID(label, text), text })),
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
        /**
         * NEVER RECALLED, oldest first.
         *
         * 🔴 The absence of a ledger row is the signal — nothing writes a zero row on ingest, so "no
         * usage" and "never returned by a recall" are the same statement. That makes this an ANTI-JOIN
         * across two stores, which is why it is bounded and says so: a page of the oldest short rows
         * from the graph, minus everything the ledger has seen, hydrated for the handful that survive.
         *
         * ⚠️ `scanned` and `partial` are the honesty. If every one of the oldest rows HAS been
         * recalled, this answers empty while never-used memories exist further along — and a viewer
         * that could not tell would present "nothing to clean up" as a finding.
         */
        .handle(
          "neverUsed",
          Effect.fn("MemoryHttpApi.neverUsed")(function* (ctx) {
            const limit = Math.max(1, Math.min(ctx.query.limit ?? 50, 500))
            const scan = Math.max(limit, Math.min(ctx.query.scan ?? 2000, 20000))
            const candidates = yield* memory
              .candidates({
                ...(csv(ctx.query.scopes) ? { scopes: csv(ctx.query.scopes)! } : {}),
                order: "oldest",
                limit: scan,
              })
              .pipe(Effect.orElseSucceed(() => []))
            const seen = yield* MemoryAccessLedger.everAccessed(
              db,
              candidates.map((row) => row.id),
            )
            const unused = candidates.filter((row) => !seen.has(row.id)).slice(0, limit)
            const rows = yield* memory.byIds(unused.map((row) => row.id)).pipe(Effect.orElseSucceed(() => []))
            return { items: rows, scanned: candidates.length, partial: candidates.length >= scan }
          }),
        )
        .handle(
          "usefulMemories",
          Effect.fn("MemoryHttpApi.usefulMemories")(function* (ctx) {
            const usage = yield* MemoryAccessLedger.usefulMemories(
              db,
              Math.max(1, Math.min(ctx.query.limit ?? 50, 500)),
            )
            return { items: yield* withUsage(usage) }
          }),
        )
        .handle(
          "correctionProne",
          Effect.fn("MemoryHttpApi.correctionProne")(function* (ctx) {
            const groups = yield* MemoryAccessLedger.correctionProne(db, {
              ...(ctx.query.minCorrected === undefined ? {} : { minCorrected: ctx.query.minCorrected }),
              ...(ctx.query.limit === undefined ? {} : { limit: ctx.query.limit }),
            })
            const usage = yield* MemoryAccessLedger.usageForConflictKeys(
              db,
              groups.map((group) => group.conflictKey),
            )
            const items = yield* withUsage(usage)
            const keyOf = new Map(usage.map((row) => [row.memoryID, row.conflictKey] as const))
            return {
              groups: groups.map((group) => ({
                ...group,
                items: items.filter((item) => keyOf.get(item.id) === group.conflictKey),
              })),
            }
          }),
        )
        .handle(
          "usageDetail",
          Effect.fn("MemoryHttpApi.usageDetail")(function* (ctx) {
            const usage = yield* MemoryAccessLedger.usageFor(db, [ctx.query.id])
            const accesses = yield* MemoryAccessLedger.accessesFor(db, ctx.query.id)
            const row = usage.get(ctx.query.id)
            return { usage: row === undefined ? null : counts(row), accesses }
          }),
        )
        .handle(
          "feedback",
          Effect.fn("MemoryHttpApi.feedback")(function* (ctx) {
            // A vouch may be the FIRST thing the ledger ever hears about this memory — a person can
            // mark one useful that recall has never returned — so the row it inserts needs a real
            // scope, and only the store knows it. A memory that no longer exists looks up empty and
            // files under `""`, which is honest: nothing will ever match it again.
            const row = (yield* memory.byIds([ctx.payload.id]).pipe(Effect.orElseSucceed(() => [])))[0]
            yield* MemoryAccessLedger.feedback(db, {
              id: ctx.payload.id,
              useful: ctx.payload.useful,
              at: Date.now(),
              ...(row === undefined ? {} : { scope: row.scope }),
            })
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
    )
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
