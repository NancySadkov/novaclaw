import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Database } from "@novaclaw/core/database/database"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentStatusDerive } from "@novaclaw/core/agent-status/derive"
import { MemoryAccessLedger } from "@novaclaw/core/kb-graph/access-ledger"
import { MemoryAtlasCaption } from "@novaclaw/core/kb-graph/memory-atlas-caption"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Log } from "@novaclaw/schema/log"
import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"
import type { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { ensureLiveChat } from "@novaclaw/core/session"
import { EventV2 } from "@novaclaw/core/event"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionStore } from "@novaclaw/core/session/store"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { MemoryApi, handlerLayer } from "../handler-api"

/** A store fault is a 400 with the store's own reason, never a 500 — the caller can act on it. */
const asBadRequest = <A, R>(effect: Effect.Effect<A, MemoryClient.MemoryError, R>) =>
  effect.pipe(
    Effect.catchTag("MemoryClient.MemoryError", (error) =>
      Effect.fail(new InvalidRequestError({ message: error.reason })),
    ),
  )

/**
 * Erase every memory in every scope, for every agent — Nova included.
 *
 * 🔴 Owner, 2026-08-22: *"erases all RAGs from all agents, including Nova — that will simplify running
 * tabula rasa tests, without resetting entire Novaclaw install."* Deliberately total: an "everything
 * except the governing agent" arm would leave a clean-slate run standing on Nova's leftovers, which is
 * the one thing this exists to prevent. The charter protects Nova's IDENTITY — its profile is fixed in
 * code and returns on the next boot — not its filing cabinet, which is data like anyone else's.
 *
 * ⚠️ **The confirmation lives in the CLIENT.** A route that refused without a magic flag would read as
 * safety and would not be one: whatever can call this once can call it twice. What makes it safe is
 * that the only surface offering it asks first (Settings → Health), and that the COUNT comes back so
 * the answer is auditable afterwards — "erased 0" and "erased 1,412" are different facts.
 */
/** The ledger's verdict, on the wire. Named once so every noise view answers with the same shape. */
const counts = (usage: MemoryAccessLedger.Usage) => ({
  accesses: usage.accesses,
  uses: usage.uses,
  useful: usage.useful,
  corrections: usage.corrections,
  firstAccessedAt: usage.firstAccessedAt,
  lastAccessedAt: usage.lastAccessedAt,
})

const bounded = (value: number | undefined, fallback: number, max: number) =>
  Math.max(1, Math.min(value ?? fallback, max))

/** The store clamps a list request to this many rows, even when a caller asks for more. */
export const MEMORY_EXPORT_PAGE_SIZE = 2_000

/**
 * Read a complete, restorable backup view without turning a store fault into an empty archive.
 *
 * The store owns the 2,000-row ceiling, so this loop lives beside the handler rather than in the
 * browser. A failure on page two fails the whole request: returning page one would make a truncated
 * backup indistinguishable from a complete one immediately before a destructive erase.
 */
export const exportAllMemory = (memory: Pick<MemoryClient.Interface, "list">, includeInvalid = false) =>
  Effect.gen(function* () {
    const rows: MemoryClient.MemoryRow[] = []
    let offset = 0

    while (true) {
      const page = yield* asBadRequest(memory.list({ includeInvalid, limit: MEMORY_EXPORT_PAGE_SIZE, offset }))
      rows.push(...page)
      if (page.length < MEMORY_EXPORT_PAGE_SIZE) return rows
      offset += page.length
    }
  })

/** Keep the store's exact count and fault; neither may collapse into a plausible-looking zero. */
export const eraseAllMemory = (memory: Pick<MemoryClient.Interface, "eraseAll">) => asBadRequest(memory.eraseAll())

export const MemoryHandler = handlerLayer(
  HttpApiBuilder.group(MemoryApi, "server.memory", (handlers) =>
    Effect.gen(function* () {
      /**
       * The P3 access ledger lives in the instance database, beside the store rather than inside it.
       *
       * ⚠️ Resolved HERE, in the group's build, and captured — not read per request. The handler
       * effects run with the request's context, which is not this one; a service read inside them is
       * the shape that made every `memory.*` event a silent no-op in the `kb` tool (see
       * `kb-graph/memory-observed.ts`).
       */
      const { db } = yield* Database.Service
      const atlasLabeller = yield* AgentStatusDerive.makeLabeller()
      // 🔴 The officer's chat is OPENED when it has none (`ensureLiveChat`), so the atlas captions no
      // longer disappear for a colleague the user has never opened. Resolved HERE, in the group's
      // build, for the reason directly above: a service read inside the handler effects is the shape
      // that made every `memory.*` event a silent no-op.
      const events = yield* EventV2.Service
      const projects = yield* ProjectV2.Service
      const sessions = yield* SessionStore.Service
      const agentConfigs = yield* AgentConfigStore.Service

      /**
       * Hydrate the memories behind a set of ledger rollups, keeping the verdict beside each row.
       *
       * ⚠️ A rollup whose memory is GONE simply drops out — `byIds` skips ids it cannot find rather
       * than faking a row. That is the honest answer: the ledger is a record of what recall did, and
       * a memory that has since been invalidated is not something a noise view should offer to act
       * on.
       */
      const withUsage = (memory: MemoryClient.Interface, usage: ReadonlyArray<MemoryAccessLedger.Usage>) =>
        Effect.gen(function* () {
          const rows = yield* asBadRequest(memory.byIds(usage.map((row) => row.memoryID)))
          const byID = new Map(usage.map((row) => [row.memoryID, row] as const))
          return rows.map((row) => {
            const found = byID.get(row.id)
            return found === undefined ? row : { ...row, usage: counts(found) }
          })
        })

      return (
        handlers
          .handle(
            "memory.erase",
            Effect.fn(function* () {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const erased = yield* eraseAllMemory(memory)
              yield* Log.event("kb.memory.erased", { "memory.rows": erased })
              return erased
            }),
          )
          .handle(
            "memory.export",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              return yield* exportAllMemory(memory, ctx.payload.includeInvalid)
            }),
          )
          .handle(
            "world-memory.list",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              return yield* asBadRequest(
                worldMemory.list({
                  ...(ctx.payload.scopes === undefined ? {} : { scopes: ctx.payload.scopes }),
                  ...(ctx.payload.kinds === undefined ? {} : { kinds: ctx.payload.kinds as never }),
                  ...(ctx.payload.statuses === undefined ? {} : { statuses: ctx.payload.statuses as never }),
                  ...(ctx.payload.includeInvalid === undefined ? {} : { includeInvalid: ctx.payload.includeInvalid }),
                  ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
                  ...(ctx.payload.offset === undefined ? {} : { offset: ctx.payload.offset }),
                }),
              )
            }),
          )
          .handle(
            "world-memory.graph",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              return yield* asBadRequest(
                worldMemory.graph({
                  ...(ctx.payload.scopes === undefined ? {} : { scopes: ctx.payload.scopes }),
                  ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
                }),
              )
            }),
          )
          .handle(
            "world-memory.captions",
            Effect.fn(function* (ctx) {
              const scope = ctx.payload.scope
              const agentID =
                scope === "global" ? AgentV2.NOVA_ID : scope.startsWith("agent:") ? scope.slice(6) : undefined
              if (!agentID)
                return yield* Effect.fail(
                  new InvalidRequestError({ message: "Atlas captions require one officer-owned cabinet" }),
                )

              const chatID = yield* ensureLiveChat({ db, events, projects, store: sessions, agentConfigs }, AgentV2.ID.make(agentID))
              // Only "there is no such colleague" — retired, or an id that is not an officer. The
              // atlas has no model to label with, and says so rather than inventing captions.
              if (chatID === undefined) return { status: "unavailable" as const, clusters: [], memories: [] }

              const clusterIDs = ctx.payload.clusters.flatMap((cluster) => cluster.ids)
              const requestedIDs = [...new Set([...clusterIDs, ...ctx.payload.memories])]
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const rows = yield* asBadRequest(memory.byIds(requestedIDs))
              const byID = new Map(rows.map((row) => [row.id, row] as const))
              // The endpoint has owner authority so it can hydrate ids, but an id supplied beside a
              // cabinet must never turn into a cross-cabinet caption oracle. Missing/raced rows are
              // simply absent; a row from another scope makes the whole request invalid.
              if (rows.some((row) => row.scope !== scope))
                return yield* Effect.fail(new InvalidRequestError({ message: "A memory is outside this cabinet" }))

              const clusterRecords = ctx.payload.clusters
                .map((cluster, index) => ({
                  id: cluster.id,
                  key: `C${index}`,
                  kind: "cluster" as const,
                  excerpts: cluster.ids.map((id) => byID.get(id)?.text ?? "").filter(Boolean),
                }))
                .filter((record) => record.excerpts.length > 0)
              const memoryRecords = ctx.payload.memories
                .map((id, index) => ({
                  id,
                  key: `M${index}`,
                  kind: "memory" as const,
                  excerpts: byID.has(id) ? [byID.get(id)!.text] : [],
                }))
                .filter((record) => record.excerpts.length > 0)
              const records = [...clusterRecords, ...memoryRecords]
              if (records.length === 0) return { status: "unavailable" as const, clusters: [], memories: [] }

              const raw = yield* atlasLabeller.short(chatID, {
                system: MemoryAtlasCaption.SYSTEM,
                text: MemoryAtlasCaption.prompt(records),
                task: "memory-atlas-captions",
                // Same presentation-only path as command captions: never spend reasoning tokens to
                // name UI chrome, even when the officer's ordinary model is a thinking model.
                reasoningBudget: 0,
              })
              if (!raw) return { status: "unavailable" as const, clusters: [], memories: [] }

              const labels = MemoryAtlasCaption.parse(raw, new Set(records.map((record) => record.key)))
              const clusters = clusterRecords.flatMap((record) => {
                const label = labels.get(record.key)
                return label ? [{ id: record.id, label }] : []
              })
              const memories = memoryRecords.flatMap((record) => {
                const label = labels.get(record.key)
                return label ? [{ id: record.id, label }] : []
              })
              const returned = clusters.length + memories.length
              return {
                status: returned === records.length ? ("generated" as const) : ("partial" as const),
                clusters,
                memories,
              }
            }),
          )
          .handle(
            "world-memory.clearScope",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              yield* asBadRequest(worldMemory.clearScope(ctx.payload.scope))
              return true
            }),
          )
          .handle(
            "world-memory.invalidate",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              yield* asBadRequest(worldMemory.invalidate(ctx.payload.id, MemoryAccess.owner()))
              return true
            }),
          )
          .handle(
            "world-memory.claim.status",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              return yield* asBadRequest(
                worldMemory.setClaimStatus(ctx.payload.id, ctx.payload.status, MemoryAccess.owner()),
              )
            }),
          )
          .handle(
            "world-memory.feedback",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              const row = (yield* asBadRequest(worldMemory.byIds([ctx.payload.id])))[0]
              if (!row) return yield* Effect.fail(new InvalidRequestError({ message: "That memory is unavailable" }))
              yield* MemoryAccessLedger.feedback(db, {
                id: ctx.payload.id,
                useful: ctx.payload.useful,
                at: Date.now(),
                scope: row.scope,
              }).pipe(Effect.mapError(() => new InvalidRequestError({ message: "Could not save memory protection" })))
              return true
            }),
          )
          .handle(
            "world-memory.erase",
            Effect.fn(function* () {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              const erased = yield* eraseAllMemory(worldMemory)
              yield* Log.event("kb.world.erased", { "memory.rows": erased })
              return erased
            }),
          )
          .handle(
            "world-memory.export",
            Effect.fn(function* (ctx) {
              const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
              return yield* exportAllMemory(worldMemory, ctx.payload.includeInvalid)
            }),
          )
          /**
           * 🔴 ARCHIVE / RESTORE. The engine, the client and the `memory.claim.status` event all shipped
           * together and this was the missing link — the Memory app's button was rendered DISABLED with
           * a sentence naming exactly this gap.
           *
           * ⚠️ `MemoryAccess.owner()`, like every other endpoint on the Memory app's surface: this is
           * the human at their own instance, and confining "stop remembering that" to one chat would be
           * a different product. A model never reaches this — it goes through the `kb` tool, whose
           * access is built from the session it runs in.
           *
           * ⚠️ The publish is the STORE's, not this handler's. `MemoryObserved` wraps the client the
           * layer provides, so the overlay updates whoever moved the claim; announcing it from here as
           * well would double every archive in the feed and make the event mean "an HTTP caller did
           * this" rather than "the store did this".
           */
          .handle(
            "memory.claim.status",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const changed = yield* asBadRequest(
                memory.setClaimStatus(ctx.payload.id, ctx.payload.status, MemoryAccess.owner()),
              )
              return changed
            }),
          )
          /**
           * 🔴 RECORD A GOVERNED CLAIM — the first HTTP path in the instance that reaches `addClaim`.
           *
           * Plain `addMemory` writes have no subject, predicate or conflict key. This governed path
           * makes corrections reachable to API clients as well as the session runner.
           */
          .handle(
            "memory.claim.add",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const result = yield* asBadRequest(
                memory.addClaim(
                  {
                    scope: ctx.payload.scope ?? "global",
                    statement: ctx.payload.statement,
                    ...(ctx.payload.subject === undefined ? {} : { subject: ctx.payload.subject }),
                    ...(ctx.payload.predicate === undefined ? {} : { predicate: ctx.payload.predicate }),
                    ...(ctx.payload.confidence === undefined ? {} : { confidence: ctx.payload.confidence }),
                    ...(ctx.payload.source === undefined ? {} : { source: ctx.payload.source }),
                    ...(ctx.payload.agent === undefined ? {} : { agent: ctx.payload.agent }),
                    ...(ctx.payload.validFrom === undefined ? {} : { validFrom: ctx.payload.validFrom }),
                    ...(ctx.payload.evidence === undefined
                      ? {}
                      : {
                          evidence: ctx.payload.evidence.map((item) => ({
                            kind: item.kind,
                            locator: item.locator,
                            ...(item.label === undefined ? {} : { label: item.label }),
                          })),
                        }),
                    relation: "staged" as const,
                  },
                  MemoryAccess.owner(),
                ),
              )
              return {
                ok: result.ok,
                ...(result.id === undefined ? {} : { id: result.id }),
                ...(result.status === undefined ? {} : { status: result.status }),
                ...(result.identified === undefined ? {} : { identified: result.identified }),
                ...(result.deduped === undefined ? {} : { deduped: result.deduped }),
                superseded: result.superseded,
                ...(result.reason === undefined ? {} : { reason: result.reason }),
              }
            }),
          )
          /**
           * 🔴 THE FOUR NOISE VIEWS AND THE VOUCH, moved here from the legacy `/memory/*` group.
           *
           * They are what makes the pruning protection reachable: `usage/useful` is the list of
           * memories somebody vouched for, `feedback` is the only way to become one, and a vouched
           * memory is excluded from the forgetting pass outright rather than merely weighted.
           */
          .handle(
            "memory.usage.neverUsed",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const limit = bounded(ctx.payload.limit, 50, 500)
              const scan = Math.max(limit, Math.min(ctx.payload.scan ?? 2000, 20000))
              const candidates = yield* memory
                .candidates({
                  ...(ctx.payload.scopes && ctx.payload.scopes.length > 0 ? { scopes: ctx.payload.scopes } : {}),
                  order: "oldest",
                  limit: scan,
                })
                .pipe(asBadRequest)
              const seen = yield* MemoryAccessLedger.everAccessed(
                db,
                candidates.map((row) => row.id),
              )
              const unused = candidates.filter((row) => !seen.has(row.id)).slice(0, limit)
              const rows = yield* asBadRequest(memory.byIds(unused.map((row) => row.id)))
              // `partial` is the honest half: a short answer is not proof there are no more.
              return { items: rows, scanned: candidates.length, partial: candidates.length >= scan }
            }),
          )
          .handle(
            "memory.usage.useful",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const usage = yield* MemoryAccessLedger.usefulMemories(db, bounded(ctx.payload.limit, 50, 500))
              return { items: yield* withUsage(memory, usage) }
            }),
          )
          .handle(
            "memory.usage.corrections",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              const groups = yield* MemoryAccessLedger.correctionProne(db, {
                ...(ctx.payload.minCorrected === undefined ? {} : { minCorrected: ctx.payload.minCorrected }),
                ...(ctx.payload.limit === undefined ? {} : { limit: ctx.payload.limit }),
              })
              const usage = yield* MemoryAccessLedger.usageForConflictKeys(
                db,
                groups.map((group) => group.conflictKey),
              )
              const items = yield* withUsage(memory, usage)
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
            "memory.usage.detail",
            Effect.fn(function* (ctx) {
              const usage = yield* MemoryAccessLedger.usageFor(db, [ctx.payload.id])
              const accesses = yield* MemoryAccessLedger.accessesFor(db, ctx.payload.id)
              const row = usage.get(ctx.payload.id)
              return { usage: row === undefined ? null : counts(row), accesses }
            }),
          )
          .handle(
            "memory.protection",
            Effect.fn(function* (ctx) {
              return yield* MemoryAccessLedger.protectionFor(db, ctx.payload.ids).pipe(
                Effect.mapError(() => new InvalidRequestError({ message: "Could not read memory protection" })),
              )
            }),
          )
          .handle(
            "memory.feedback",
            Effect.fn(function* (ctx) {
              const memory = WorldMemory.client(yield* WorldMemory.node.service)
              // The scope rides along so a cleared cabinet can drop its ledger rows with it.
              const row = (yield* asBadRequest(memory.byIds([ctx.payload.id])))[0]
              if (!row) return yield* Effect.fail(new InvalidRequestError({ message: "That memory is unavailable" }))
              yield* MemoryAccessLedger.feedback(db, {
                id: ctx.payload.id,
                useful: ctx.payload.useful,
                at: Date.now(),
                ...(row === undefined ? {} : { scope: row.scope }),
              }).pipe(Effect.mapError(() => new InvalidRequestError({ message: "Could not save memory protection" })))
              return true
            }),
          )
      )
    }),
  ),
)
