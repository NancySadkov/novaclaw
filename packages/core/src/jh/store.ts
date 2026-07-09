export * as JhStore from "./store"

// jh — save/load/list the engine state over a plain `db` handle (the deps-taking seam pattern —
// SessionMessageRead.list(db, …); NO service/layer, rule §0.7.1). The State's Maps (tree.nodes,
// telemetry) can't live in a JSON column, so the jh_plan.state blob stores them as entry arrays;
// artifacts and the log get their own rows so they append/replace cleanly. Timestamps come in as `now`
// (never Date.now() — determinism).

import { Effect } from "effect"
import { asc, eq } from "drizzle-orm"
import type { Database } from "../database/database"
import { JhArtifactTable, JhLogTable, JhPlanTable } from "./sql"
import type { JhArtifact } from "./artifact"
import type { JhBudget } from "./budget"
import type { JhEngine } from "./engine"
import type { JhLog } from "./log"
import type { JhStep } from "./step"
import type { JhTree } from "./tree"

type Db = Database.Interface["db"]

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

export function list(db: Db): Effect.Effect<ReadonlyArray<{ id: string; goal: string; status: string; timeUpdated: number }>> {
  return Effect.gen(function* () {
    const rows = yield* db.select().from(JhPlanTable).all().pipe(Effect.orDie)
    return rows.map((r) => ({ id: r.id, goal: r.goal, status: r.status, timeUpdated: r.timeUpdated }))
  })
}
