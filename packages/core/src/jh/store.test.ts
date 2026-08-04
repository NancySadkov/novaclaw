import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { eq, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { migrations } from "../database/migration.gen"
import { Hash } from "../util/hash"
import { JhArtifactTable, JhLogTable } from "./sql"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import { JhEngine } from "./engine"
import { JhStore } from "./store"
import { JhTree } from "./tree"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
const withDb = <A>(fn: (db: Database.Interface["db"]) => Effect.Effect<A>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      return yield* fn(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

/**
 * The UPGRADE path — an EXISTING user database, built by the tracked migration chain.
 *
 * `withDb` above uses `apply`, which on an empty database takes the FRESH arm and runs
 * `schema.gen.ts`; a table's index could therefore be present for every new install and missing for
 * every install that already has data. `applyOnly(db, migrations)` is the other half.
 */
const withChainDb = <A>(
  fn: (db: Database.Interface["db"]) => Effect.Effect<A>,
  chain: typeof migrations = migrations,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.applyOnly(db, chain)
      return yield* fn(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const sampleState = (): JhEngine.State => {
  let tree = JhTree.create({ goal: "root goal", size: "atomic", success: "ok" })
  tree = JhTree.setStatus(tree, JhTree.ROOT_ID, "committed")
  return {
    tree,
    artifacts: [{ id: "add.c", type: "file", hash: "deadbeef", content: "int add(){}" }],
    log: [
      { type: "task_started", goal: "root goal", seq: 0 },
      { type: "committed", step: "root", seq: 1 },
    ],
    telemetry: new Map([["root", { attempts: 2, verifierFails: 1, correctorCalls: 1, parseFails: 0 }]]),
  }
}

describe("JhStore", () => {
  test("save → load round-trips the State exactly", async () => {
    const loaded = await withDb((db) =>
      Effect.gen(function* () {
        const state = sampleState()
        yield* JhStore.save(db, { id: "p1", goal: "root goal", status: "done", state, now: 100 })
        return yield* JhStore.load(db, "p1")
      }),
    )
    expect(loaded).toBeDefined()
    expect(loaded!.goal).toBe("root goal")
    expect(loaded!.status).toBe("done")
    const original = sampleState()
    expect(loaded!.state.tree.nodes).toEqual(original.tree.nodes)
    expect(loaded!.state.artifacts).toEqual(original.artifacts)
    expect(loaded!.state.log).toEqual(original.log)
    expect(loaded!.state.telemetry).toEqual(original.telemetry)
  })

  test("save twice appends new log rows, replaces artifacts", async () => {
    const loaded = await withDb((db) =>
      Effect.gen(function* () {
        const s1 = sampleState()
        yield* JhStore.save(db, { id: "p2", goal: "g", status: "running", state: s1, now: 1 })
        const s2: JhEngine.State = {
          ...s1,
          log: [...s1.log, { type: "task_done", seq: 2 }],
          artifacts: [{ id: "add.c", type: "file", hash: "newhash", content: "changed" }],
        }
        yield* JhStore.save(db, { id: "p2", goal: "g", status: "done", state: s2, now: 2 })
        return yield* JhStore.load(db, "p2")
      }),
    )
    expect(loaded!.state.log.length).toBe(3) // 2 original + 1 appended
    expect(loaded!.state.artifacts).toEqual([{ id: "add.c", type: "file", hash: "newhash", content: "changed" }])
    expect(loaded!.status).toBe("done")
  })

  test("load unknown id → undefined; each saved plan keeps its own status", async () => {
    // (`JhStore.list` used to be exercised here. It had ZERO production callers and full-scanned
    // jh_plan decoding every `state` blob — deleted with the U7 retention work rather than kept
    // as a fast-growing convenience nobody called.)
    const result = await withDb((db) =>
      Effect.gen(function* () {
        const missing = yield* JhStore.load(db, "nope")
        yield* JhStore.save(db, { id: "a", goal: "ga", status: "running", state: sampleState(), now: 1 })
        yield* JhStore.save(db, { id: "b", goal: "gb", status: "blocked", state: sampleState(), now: 2 })
        return { missing, a: yield* JhStore.load(db, "a"), b: yield* JhStore.load(db, "b") }
      }),
    )
    expect(result.missing).toBeUndefined()
    expect(result.a!.status).toBe("running")
    expect(result.b!.status).toBe("blocked")
  })

  // ── the per-TASK plan id (runner/llm.ts) ───────────────────────────────────────────────────
  // The runner used to key a Strict plan `jh_<sessionID>`, so a session's SECOND task landed on
  // the FIRST task's row. Every destructive edge of this store then fired at once: the plan blob
  // is onConflictDoUpdate (B overwrites A's tree), the log is onConflictDoNothing on (planID, seq)
  // (B's rows are DROPPED, A's kept), and artifacts are replaced by plan id (A's are hard-DELETED
  // by B's first checkpoint). Resume then rebuilt A's journal against B's tree.
  const taskState = (tag: string): JhEngine.State => ({
    ...sampleState(),
    artifacts: [{ id: `${tag}.c`, type: "file", hash: `hash-${tag}`, content: `/* ${tag} */` }],
    log: [
      { type: "task_started", goal: `goal ${tag}`, seq: 0 },
      { type: "committed", step: "root", seq: 1 },
    ],
  })

  test("two tasks in ONE session keep separate log rows and separate artifacts", async () => {
    const loaded = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, {
          id: "jh_ses_1_msg_a",
          goal: "goal a",
          status: "running",
          state: taskState("a"),
          now: 1,
        })
        yield* JhStore.save(db, {
          id: "jh_ses_1_msg_b",
          goal: "goal b",
          status: "running",
          state: taskState("b"),
          now: 2,
        })
        return {
          a: yield* JhStore.load(db, "jh_ses_1_msg_a"),
          b: yield* JhStore.load(db, "jh_ses_1_msg_b"),
        }
      }),
    )
    expect(loaded.a!.goal).toBe("goal a")
    expect(loaded.b!.goal).toBe("goal b")
    expect(loaded.a!.state.log).toEqual(taskState("a").log)
    expect(loaded.b!.state.log).toEqual(taskState("b").log)
    expect(loaded.a!.state.artifacts).toEqual(taskState("a").artifacts)
    expect(loaded.b!.state.artifacts).toEqual(taskState("b").artifacts)
  })

  test("NEGATIVE CONTROL: the old session-scoped key destroys the first task", async () => {
    const loaded = await withDb((db) =>
      Effect.gen(function* () {
        // exactly what `jh_${sessionID}` did: both tasks write the SAME plan id
        yield* JhStore.save(db, { id: "jh_ses_1", goal: "goal a", status: "running", state: taskState("a"), now: 1 })
        yield* JhStore.save(db, { id: "jh_ses_1", goal: "goal b", status: "running", state: taskState("b"), now: 2 })
        return yield* JhStore.load(db, "jh_ses_1")
      }),
    )
    expect(loaded!.goal).toBe("goal b") // B's plan blob overwrote A's
    expect(loaded!.state.log).toEqual(taskState("a").log) // …while B's log rows were silently dropped
    expect(loaded!.state.artifacts).toEqual(taskState("b").artifacts) // …and A's artifacts are GONE
  })

  test("latest() finds the session's newest plan, ignoring other sessions and legacy rows", async () => {
    const found = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, {
          id: "jh_ses_1_msg_a",
          goal: "goal a",
          status: "done",
          state: taskState("a"),
          now: 10,
        })
        yield* JhStore.save(db, {
          id: "jh_ses_1_msg_b",
          goal: "goal b",
          status: "running",
          state: taskState("b"),
          now: 20,
        })
        yield* JhStore.save(db, {
          id: "jh_ses_2_msg_c",
          goal: "other chat",
          status: "running",
          state: taskState("c"),
          now: 30,
        })
        // a pre-change session-scoped row: no trailing separator, so the prefix never matches it
        yield* JhStore.save(db, { id: "jh_ses_1", goal: "orphan", status: "running", state: taskState("d"), now: 40 })
        return {
          one: yield* JhStore.latest(db, "jh_ses_1_"),
          two: yield* JhStore.latest(db, "jh_ses_2_"),
          none: yield* JhStore.latest(db, "jh_ses_3_"),
        }
      }),
    )
    expect(found.one!.id).toBe("jh_ses_1_msg_b")
    expect(found.one!.goal).toBe("goal b")
    expect(found.one!.state.artifacts).toEqual(taskState("b").artifacts)
    expect(found.two!.id).toBe("jh_ses_2_msg_c")
    expect(found.none).toBeUndefined()
  })

  test("runner/llm.ts keys the Strict plan per TASK, not per session", () => {
    // A source assertion: nothing in the fast suite executes `llm.ts`, and reverting the key format
    // compiles green while silently restoring the destruction the tests above characterize.
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "session", "runner", "llm.ts"), "utf8")
    expect(source).toContain("`jh_${sessionID}_${taskKey}`")
    expect(source).not.toContain("`jh_${sessionID}`")
    // …and the cascade in `removeSessionRecord` rebuilds that same key from `sessionPrefix`, so the
    // two statements of the format are pinned to each other rather than drifting apart.
    expect(JhStore.sessionPrefix("ses_1")).toBe("jh_ses_1_")
  })

  // ── retention (U7 Part B) ─────────────────────────────────────────────────────────────────
  // One jh_plan + N jh_log + M jh_artifact per Strict TASK, and for a while nothing deleted any
  // of it — the tables were bounded by install age. Both purges are lazy and live on the WRITE
  // path (trash.ts's stance), so a read never destroys.
  const planRowCounts = (db: Database.Interface["db"], planID: string) =>
    Effect.gen(function* () {
      const logs = yield* db.select().from(JhLogTable).where(eq(JhLogTable.planID, planID)).all().pipe(Effect.orDie)
      const artifacts = yield* db
        .select()
        .from(JhArtifactTable)
        .where(eq(JhArtifactTable.planID, planID))
        .all()
        .pipe(Effect.orDie)
      return { logs: logs.length, artifacts: artifacts.length }
    })

  test("purgeExpired drops stale plans WITH their log and artifact rows, and keeps fresh ones", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, { id: "old", goal: "g", status: "done", state: taskState("o"), now: 1_000 })
        yield* JhStore.save(db, { id: "fresh", goal: "g", status: "running", state: taskState("f"), now: 9_000 })
        const before = yield* planRowCounts(db, "old")
        // now = 10_000, ttl = 5_000 → cutoff 5_000: "old" (1_000) goes, "fresh" (9_000) stays.
        const purged = yield* JhStore.purgeExpired(db, { now: 10_000, ttlMs: 5_000 })
        return {
          purged,
          before,
          after: yield* planRowCounts(db, "old"),
          old: yield* JhStore.load(db, "old"),
          fresh: yield* JhStore.load(db, "fresh"),
        }
      }),
    )
    expect(result.before).toEqual({ logs: 2, artifacts: 1 })
    expect(result.purged).toBe(1)
    expect(result.old).toBeUndefined()
    expect(result.after).toEqual({ logs: 0, artifacts: 0 }) // the manual cascade actually fired
    expect(result.fresh!.state.artifacts).toEqual(taskState("f").artifacts) // untouched
  })

  test("NEGATIVE CONTROL: inside the TTL purgeExpired deletes nothing", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, { id: "p", goal: "g", status: "running", state: taskState("p"), now: 9_000 })
        const purged = yield* JhStore.purgeExpired(db, { now: 10_000, ttlMs: 5_000 })
        return { purged, plan: yield* JhStore.load(db, "p"), rows: yield* planRowCounts(db, "p") }
      }),
    )
    expect(result.purged).toBe(0)
    expect(result.plan).toBeDefined()
    expect(result.rows).toEqual({ logs: 2, artifacts: 1 })
  })

  test("purgeSession is the missing session.deleted cascade: this chat's plans only", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, { id: "jh_ses_1_msg_a", goal: "a", status: "done", state: taskState("a"), now: 1 })
        yield* JhStore.save(db, { id: "jh_ses_1_msg_b", goal: "b", status: "running", state: taskState("b"), now: 2 })
        yield* JhStore.save(db, { id: "jh_ses_1", goal: "legacy", status: "running", state: taskState("l"), now: 3 })
        yield* JhStore.save(db, { id: "jh_ses_2_msg_c", goal: "c", status: "running", state: taskState("c"), now: 4 })
        const purged = yield* JhStore.purgeSession(db, "ses_1")
        return {
          purged,
          a: yield* JhStore.load(db, "jh_ses_1_msg_a"),
          legacy: yield* JhStore.load(db, "jh_ses_1"),
          other: yield* JhStore.load(db, "jh_ses_2_msg_c"),
          aRows: yield* planRowCounts(db, "jh_ses_1_msg_a"),
          otherRows: yield* planRowCounts(db, "jh_ses_2_msg_c"),
        }
      }),
    )
    expect(result.purged).toBe(3) // both per-task plans AND the legacy session-scoped row
    expect(result.a).toBeUndefined()
    expect(result.legacy).toBeUndefined()
    expect(result.aRows).toEqual({ logs: 0, artifacts: 0 })
    expect(result.other).toBeDefined() // …and the neighbouring chat is untouched
    expect(result.otherRows).toEqual({ logs: 2, artifacts: 1 })
  })

  test("purgeSession does NOT take a session whose id is a prefix of another", async () => {
    // `jh_ses_1_` vs `jh_ses_10_msg_a`: a naive `LIKE 'jh_ses_1%'` would eat the second chat's
    // plans. The range is bounded on both sides, so it cannot.
    const result = await withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, { id: "jh_ses_1_msg_a", goal: "a", status: "done", state: taskState("a"), now: 1 })
        yield* JhStore.save(db, { id: "jh_ses_10_msg_a", goal: "b", status: "done", state: taskState("b"), now: 2 })
        const purged = yield* JhStore.purgeSession(db, "ses_1")
        return { purged, neighbour: yield* JhStore.load(db, "jh_ses_10_msg_a") }
      }),
    )
    expect(result.purged).toBe(1)
    expect(result.neighbour).toBeDefined()
  })

  test("runner/llm.ts purges on the way into a Strict drain", () => {
    // The mechanical check for the retention decision: deleting the call compiles green and the
    // behavioural tests above keep passing, while the tables silently grow forever again. Nothing
    // in the fast suite executes `llm.ts`, so this is the only place that can bite.
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "session", "runner", "llm.ts"), "utf8")
    expect(source).toContain("JhStore.purgeExpired(db,")
    // …and it must NOT be hidden inside the read: `latest` runs on every Strict turn, and a read
    // never destroys (todo.md ruling 3).
    const store = fs.readFileSync(path.join(import.meta.dir, "store.ts"), "utf8")
    const from = store.indexOf("export function latest(")
    const to = store.indexOf("export function purgeExpired(")
    expect(from).toBeGreaterThan(0)
    expect(to).toBeGreaterThan(from)
    expect(store.slice(from, to)).not.toContain("delete")
  })

  // ── the retention index (v0.2.0 batch 4) ──────────────────────────────────────────────────
  // `purgeExpired` runs once per Strict drain, i.e. on the way into every Strict turn, and its
  // `time_updated < cutoff` predicate had no index to use — the sweep read the whole table every
  // time, and the cost grew with the very table it exists to bound.
  //
  // Asserting that the index EXISTS would not be a check: an index the planner declines to use is
  // the same table scan plus a write cost on every save. So pin the PLAN, and prove the assertion
  // discriminates by dropping the index and watching the plan change.
  const RETENTION_INDEX_MIGRATION = "20260728181001_add_jh_plan_time_updated_index"
  const planFor = (db: Database.Interface["db"]) =>
    db
      // The literal `purgeExpired` builds: one column projected, one range predicate.
      .all<{ detail: string }>(sql`EXPLAIN QUERY PLAN SELECT id FROM jh_plan WHERE time_updated < 5`)
      .pipe(
        Effect.orDie,
        Effect.map((rows) => rows.map((r) => r.detail).join(" | ")),
      )

  test("purgeExpired's predicate reads the covering index, on a database built by the MIGRATION CHAIN", async () => {
    const result = await withChainDb((db) =>
      Effect.gen(function* () {
        const indexes = yield* db
          .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'jh_plan'`)
          .pipe(Effect.orDie)
        return { indexes: indexes.map((i) => i.name), plan: yield* planFor(db) }
      }),
    )
    expect(result.indexes).toContain("jh_plan_time_updated_id_idx")
    expect(result.plan).toContain("COVERING INDEX jh_plan_time_updated_id_idx")

    // NEGATIVE CONTROL — the same chain MINUS this one migration, i.e. the exact state every
    // existing user database was in before it. The identical query plans as a full table scan, so
    // the assertion above genuinely discriminates and names the migration that changes the answer.
    // (Dropping the index inside the first database instead does not work: bun:sqlite keeps the
    // prepared statements alive, so `DROP INDEX` returns SQLITE_LOCKED — measured 2026-07-28.)
    const without = await withChainDb(
      planFor,
      migrations.filter((m) => m.id !== RETENTION_INDEX_MIGRATION),
    )
    expect(without).toContain("SCAN")
    expect(without).not.toContain("jh_plan_time_updated_id_idx")
  })

  test("…and on a FRESH database built by schema.gen.ts", async () => {
    // The two schema paths are pinned equal wholesale by test/schema-equivalence.test.ts; this names
    // the one object this change adds, on the arm every NEW install takes.
    const plan = await withDb(planFor)
    expect(plan).toContain("COVERING INDEX jh_plan_time_updated_id_idx")
  })

  // ── the artifact size cap (v0.2.0 batch 4) ────────────────────────────────────────────────
  // `jh_artifact.content` holds whole file BODIES and the TTL bounds these tables in time, not in
  // size. `MAX_ARTIFACT_BYTES` is the size bound; the interesting part is what happens AT it —
  // refused whole and said out loud, never silently shortened (ruling 2: a fault is never described
  // falsely, and jh verifies steps against artifacts it believes it holds).
  const artifactOf = (id: string, content: string): JhArtifact.Stored =>
    JhArtifact.memory().put({ id, type: "file" }, content)

  const savedArtifacts = (id: string, artifacts: ReadonlyArray<JhArtifact.Stored>) =>
    withDb((db) =>
      Effect.gen(function* () {
        yield* JhStore.save(db, { id, goal: "g", status: "running", state: { ...sampleState(), artifacts }, now: 1 })
        const loaded = yield* JhStore.load(db, id)
        return { artifacts: loaded!.state.artifacts, log: loaded!.state.log }
      }),
    )

  test("an over-cap artifact body is REFUSED WHOLE and the row says so where the body would be", async () => {
    const huge = artifactOf("huge.c", "x".repeat(JhStore.MAX_ARTIFACT_BYTES + 1))
    const small = artifactOf("small.c", "int main(){}")
    const result = await savedArtifacts("cap", [huge, small])

    const stored = result.artifacts.find((a) => a.id === "huge.c")!
    expect(stored.content).toBe(
      JhStore.refusedArtifact({ id: "huge.c", bytes: JhStore.MAX_ARTIFACT_BYTES + 1, hash: huge.hash }),
    )
    // NOT a truncation: no prefix of the refused body survived anywhere in the stored text.
    expect(stored.content).not.toContain("xxxxxxxxxx")
    expect(Buffer.byteLength(stored.content, "utf8")).toBeLessThan(1_000)
    // The marker's hash is the MARKER's, so a hash-keyed memoization can never mistake it for the
    // real artifact — while the refused body's own sha256 is still stated, in the text.
    expect(stored.hash).toBe(Hash.sha256(stored.content))
    expect(stored.hash).not.toBe(huge.hash)
    expect(stored.content).toContain(huge.hash)
    expect(stored.type).toBe("file") // the ref is intact; only the body was refused
    // Granularity is the ROW: one oversize file costs neither its neighbours nor the event log.
    expect(result.artifacts.find((a) => a.id === "small.c")).toEqual(small)
    expect(result.log).toEqual(sampleState().log)
  })

  test("NEGATIVE CONTROL: a body of exactly MAX_ARTIFACT_BYTES round-trips byte-identical", async () => {
    const atCap = artifactOf("at-cap.c", "x".repeat(JhStore.MAX_ARTIFACT_BYTES))
    const result = await savedArtifacts("at-cap", [atCap])
    expect(result.artifacts).toEqual([atCap])
    expect(Buffer.byteLength(result.artifacts[0]!.content, "utf8")).toBe(JhStore.MAX_ARTIFACT_BYTES)
  })

  test("the cap counts UTF-8 BYTES, not JS characters", async () => {
    // SQLite stores TEXT as UTF-8, so bytes is what the file on disk actually costs. "é" is one JS
    // char and two UTF-8 bytes: this body is UNDER the cap by `.length` and over it by byte count,
    // so a `content.length` check would have stored it.
    const twoByte = artifactOf("accents.txt", "é".repeat(JhStore.MAX_ARTIFACT_BYTES / 2 + 1))
    expect(twoByte.content.length).toBeLessThanOrEqual(JhStore.MAX_ARTIFACT_BYTES)
    expect(Buffer.byteLength(twoByte.content, "utf8")).toBeGreaterThan(JhStore.MAX_ARTIFACT_BYTES)
    const result = await savedArtifacts("utf8", [twoByte])
    expect(result.artifacts[0]!.content).toContain("NOT STORED")
  })

  test("resume through the DB completes with the same combined log (jh.md §6b)", async () => {
    // A 2-leaf scenario; save the state at the FIRST checkpoint, then load it and resume.
    const replies = () => [
      JSON.stringify({
        goal: "root",
        size: "needs_decomposition",
        success: "ok",
        substeps: [leaf("a", "a1"), leaf("b", "b1")],
      }),
      JSON.stringify(leaf("a", "a1")),
      JSON.stringify(leaf("b", "b1")),
    ]
    const obs = () => [okObs("a1"), okObs("b1")]

    const full = await Effect.runPromise(JhEngine.runTask(mkDeps(replies(), obs()), { goal: "the task" }))
    const fullTypes = full.state.log.map((e) => e.type)

    const combined = await withDb((db) =>
      Effect.gen(function* () {
        let first: JhEngine.State | undefined
        yield* JhEngine.runTask(
          mkDeps(replies(), obs(), (s) =>
            Effect.gen(function* () {
              if (!first) {
                first = s
                yield* JhStore.save(db, { id: "run", goal: "the task", status: "running", state: s, now: 1 })
              }
            }),
          ),
          { goal: "the task" },
        )
        const reloaded = yield* JhStore.load(db, "run")
        const resumed = yield* JhEngine.runTask(
          mkDeps(
            [JSON.stringify(leaf("b", "b1"))],
            [okObs("b1")],
            undefined,
            JhArtifact.memory(reloaded!.state.artifacts),
          ),
          { goal: "the task" },
          reloaded!.state,
        )
        return resumed.state.log.map((e) => e.type)
      }),
    )
    expect(combined).toEqual(fullTypes)
  })
})

// --- minimal scripted deps for the resume test ---
const leaf = (goal: string, produce: string) => ({
  goal,
  size: "atomic",
  tool: "note",
  args: { text: "x" },
  success: "ok",
  check: { type: "artifact_present" },
  produces: [{ id: produce, type: "note" }],
})
const okObs = (id: string): JhBasicTools.Observation => ({ ok: true, output: "o", artifacts: new Map([[id, "x"]]) })
function mkDeps(
  replies: string[],
  observations: JhBasicTools.Observation[],
  checkpoint?: (s: JhEngine.State) => Effect.Effect<void>,
  artifacts = JhArtifact.memory(),
): JhEngine.Deps {
  const rq = [...replies]
  const oq = [...observations]
  const next = () => {
    const r = rq.shift()
    return r === undefined ? Effect.fail({ message: "no reply" }) : Effect.succeed(r)
  }
  return {
    introspect: next,
    correct: next,
    executor: { run: () => Effect.succeed(oq.shift() ?? { ok: false, output: "none", artifacts: new Map() }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts,
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    limits: { maxDepth: 4, maxTotalSteps: 64 },
    trigger: JhBudget.DEFAULT_TRIGGER,
    checkpoint,
  }
}
