export * as JhStore from "./store"

// jh — save/load the engine state over a plain `db` handle (the deps-taking seam pattern —
// SessionMessageRead.list(db, …); NO service/layer, rule §0.7.1). The State's Maps (tree.nodes,
// telemetry) can't live in a JSON column, so the jh_plan.state blob stores them as entry arrays;
// artifacts and the log get their own rows so they append/replace cleanly. Timestamps come in as `now`
// (never Date.now() — determinism), and that includes the retention cutoff.
//
// RETENTION (U7): every Strict task writes one jh_plan row plus N jh_log and M jh_artifact rows, and
// for a while nothing ever deleted any of them — the tables grew for the life of the install, and
// because these three carry NO foreign key to the session table (engine-internal, D10), deleting a
// chat orphaned its rows rather than cascading. Two purges close that, both LAZY and both on the
// WRITE path — the `trash.ts` stance, "called lazily — no daemon", never a read that destroys:
//   · `purgeExpired` — TTL over `timeUpdated`, called once per Strict drain from the runner. All
//     growth happens inside a Strict drain and every Strict drain begins there, so every growth
//     episode is preceded by a purge.
//   · `purgeSession` — the missing cascade, called from `removeSessionRecord`.

import { Effect } from "effect"
import { and, asc, desc, eq, gte, inArray, lt, or } from "drizzle-orm"
import type { Database } from "../database/database"
import { JhArtifactTable, JhLogTable, JhPlanTable } from "./sql"
import type { JhArtifact } from "./artifact"
import type { JhBudget } from "./budget"
import type { JhEngine } from "./engine"
import type { JhLog } from "./log"
import type { JhStep } from "./step"
import type { JhTree } from "./tree"

type Db = Database.Interface["db"]

/**
 * How long a plan survives its last update. A plan is only ever READ to resume an interrupted
 * run ("say resume to continue it"), and the run's real outputs — the files it wrote, the chat
 * summary — live elsewhere and are untouched by this. A week is far past any resume anyone
 * attempts, and it bounds the tables by RECENT ACTIVITY instead of by install age.
 */
export const DEFAULT_TTL_MS = 7 * 24 * 3600 * 1000

/**
 * The id prefix the runner keys a session's per-task plans with (`jh_<sessionID>_<taskKey>`).
 * ⚠️ The runner builds that literal itself (pinned by a source assertion in store.test.ts) — this
 * is the same fact stated where the CASCADE needs it, and the two are tested against each other.
 */
export const sessionPrefix = (sessionID: string) => `jh_${sessionID}_`

/**
 * `id LIKE '<prefix>%'` as an indexable, case-EXACT range.
 *
 * SQLite's LIKE is case-insensitive for ASCII (so it matched more than asked and needed a JS
 * re-check) and the planner cannot use the `id` primary-key index for it — every prefix lookup
 * scanned the whole table, and `latest` runs on every Strict turn. A `>=`/`<` pair on the same
 * column is an index range scan and means exactly what it says. Assumes an ASCII final character
 * (ids are `jh_<sessionID>_`), because the bound increments that one byte.
 */
const prefixRange = (column: typeof JhPlanTable.id, prefix: string) =>
  and(
    gte(column, prefix),
    lt(column, prefix.slice(0, -1) + String.fromCharCode(prefix.charCodeAt(prefix.length - 1) + 1)),
  )

/** Batch size for the manual cascade — keeps the `IN (…)` list well inside SQLite's variable limit. */
const PURGE_CHUNK = 200

/**
 * Delete plans and their children. Children FIRST: with no FK there is no cascade, and a crash
 * between the statements must not leave log/artifact rows whose plan row is gone — those would be
 * invisible to every future purge (nothing joins back to them).
 */
const deletePlans = (db: Db, ids: readonly string[]): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let i = 0; i < ids.length; i += PURGE_CHUNK) {
      const batch = ids.slice(i, i + PURGE_CHUNK)
      yield* db.delete(JhLogTable).where(inArray(JhLogTable.planID, batch)).run().pipe(Effect.orDie)
      yield* db.delete(JhArtifactTable).where(inArray(JhArtifactTable.planID, batch)).run().pipe(Effect.orDie)
      yield* db.delete(JhPlanTable).where(inArray(JhPlanTable.id, batch)).run().pipe(Effect.orDie)
    }
  })

interface SerializedState {
  readonly tree: { readonly root: string; readonly nodes: ReadonlyArray<readonly [string, JhTree.Node]> }
  readonly telemetry: ReadonlyArray<readonly [string, JhBudget.Telemetry]>
}

const serialize = (state: JhEngine.State): SerializedState => ({
  tree: { root: state.tree.root, nodes: [...state.tree.nodes] },
  telemetry: [...state.telemetry],
})

export function save(db: Db, input: { id: string; goal: string; status: string; state: JhEngine.State; now: number }): Effect.Effect<void> {
  return Effect.gen(function* () {
    const state = serialize(input.state)
    yield* db
      .insert(JhPlanTable)
      .values({ id: input.id, goal: input.goal, status: input.status, state, timeCreated: input.now, timeUpdated: input.now })
      .onConflictDoUpdate({ target: JhPlanTable.id, set: { goal: input.goal, status: input.status, state, timeUpdated: input.now } })
      .run()
      .pipe(Effect.orDie)
    // artifacts: REPLACE (latest snapshot wins)
    yield* db.delete(JhArtifactTable).where(eq(JhArtifactTable.planID, input.id)).run().pipe(Effect.orDie)
    if (input.state.artifacts.length > 0) {
      yield* db
        .insert(JhArtifactTable)
        .values(input.state.artifacts.map((a) => ({ planID: input.id, artifactID: a.id, type: a.type, hash: a.hash, content: a.content })))
        .run()
        .pipe(Effect.orDie)
    }
    // log: append-only (existing seqs are left untouched)
    if (input.state.log.length > 0) {
      yield* db
        .insert(JhLogTable)
        .values(input.state.log.map((e) => ({ planID: input.id, seq: e.seq, entry: e })))
        .onConflictDoNothing()
        .run()
        .pipe(Effect.orDie)
    }
  })
}

export function load(db: Db, id: string): Effect.Effect<{ goal: string; status: string; state: JhEngine.State } | undefined> {
  return Effect.gen(function* () {
    const plan = yield* db.select().from(JhPlanTable).where(eq(JhPlanTable.id, id)).get().pipe(Effect.orDie)
    if (!plan) return undefined
    const artifactRows = yield* db.select().from(JhArtifactTable).where(eq(JhArtifactTable.planID, id)).all().pipe(Effect.orDie)
    const logRows = yield* db.select().from(JhLogTable).where(eq(JhLogTable.planID, id)).orderBy(asc(JhLogTable.seq)).all().pipe(Effect.orDie)
    const s = plan.state as SerializedState
    const state: JhEngine.State = {
      tree: { root: s.tree.root as JhStep.StepID, nodes: new Map(s.tree.nodes.map((n) => [n[0], n[1]])) },
      artifacts: artifactRows.map((r) => ({ id: r.artifactID, type: r.type as JhArtifact.Stored["type"], hash: r.hash, content: r.content })),
      log: logRows.map((r) => r.entry as JhLog.Sequenced),
      telemetry: new Map(s.telemetry.map((t) => [t[0], t[1]])),
    }
    return { goal: plan.goal, status: plan.status, state }
  })
}

/**
 * The most recently updated plan whose id starts with `prefix`, fully loaded.
 *
 * The runner keys a plan PER TASK (`jh_<sessionID>_<taskKey>`) because a session can run many
 * Strict tasks and each owns its own log rows and artifacts, so "the plan this chat might resume"
 * is a prefix RANGE, not a point lookup (see `prefixRange` for why not `LIKE`). `timeUpdated` has
 * millisecond granularity, so the id breaks a tie — ids embed an ascending message id within a
 * session. A legacy session-scoped `jh_<sessionID>` row carries no trailing separator and sorts
 * BELOW the prefix, so it is never matched.
 */
export function latest(
  db: Db,
  prefix: string,
): Effect.Effect<{ id: string; goal: string; status: string; state: JhEngine.State } | undefined> {
  return Effect.gen(function* () {
    const row = yield* db
      .select({ id: JhPlanTable.id })
      .from(JhPlanTable)
      .where(prefixRange(JhPlanTable.id, prefix))
      .orderBy(desc(JhPlanTable.timeUpdated), desc(JhPlanTable.id))
      .limit(1)
      .get()
      .pipe(Effect.orDie)
    if (!row) return undefined
    const plan = yield* load(db, row.id)
    return plan === undefined ? undefined : { id: row.id, ...plan }
  })
}

/**
 * TTL retention: drop every plan (and its log + artifacts) untouched for longer than `ttlMs`.
 * Returns how many plans went, so a caller can log it. `now` is injected like every other
 * timestamp in this module — no `Date.now()` here.
 */
export function purgeExpired(db: Db, input: { now: number; ttlMs?: number }): Effect.Effect<number> {
  return Effect.gen(function* () {
    const cutoff = input.now - (input.ttlMs ?? DEFAULT_TTL_MS)
    const rows = yield* db
      .select({ id: JhPlanTable.id })
      .from(JhPlanTable)
      .where(lt(JhPlanTable.timeUpdated, cutoff))
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return 0
    yield* deletePlans(db, rows.map((r) => r.id))
    return rows.length
  })
}

/**
 * The cascade the schema cannot express: these tables carry no FK to the session table, so the
 * `session.deleted` projector's row-delete cascade (messages/parts/todos/tags) never reached them
 * and a deleted chat left its plans, its whole event log and its artifact CONTENT behind forever.
 * Called from `removeSessionRecord`, which covers every remover (the V2 service and the workspace
 * control-plane's session sweep both go through it).
 *
 * Takes the legacy session-scoped `jh_<sessionID>` row too — it belongs to this session just as
 * much, and nothing else will ever match it again.
 */
export function purgeSession(db: Db, sessionID: string): Effect.Effect<number> {
  return Effect.gen(function* () {
    const rows = yield* db
      .select({ id: JhPlanTable.id })
      .from(JhPlanTable)
      .where(or(prefixRange(JhPlanTable.id, sessionPrefix(sessionID)), eq(JhPlanTable.id, `jh_${sessionID}`)))
      .all()
      .pipe(Effect.orDie)
    if (rows.length === 0) return 0
    yield* deletePlans(db, rows.map((r) => r.id))
    return rows.length
  })
}
