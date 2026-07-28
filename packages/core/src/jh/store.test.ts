import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
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
        yield* JhStore.save(db, { id: "jh_ses_1_msg_a", goal: "goal a", status: "running", state: taskState("a"), now: 1 })
        yield* JhStore.save(db, { id: "jh_ses_1_msg_b", goal: "goal b", status: "running", state: taskState("b"), now: 2 })
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
        yield* JhStore.save(db, { id: "jh_ses_1_msg_a", goal: "goal a", status: "done", state: taskState("a"), now: 10 })
        yield* JhStore.save(db, { id: "jh_ses_1_msg_b", goal: "goal b", status: "running", state: taskState("b"), now: 20 })
        yield* JhStore.save(db, { id: "jh_ses_2_msg_c", goal: "other chat", status: "running", state: taskState("c"), now: 30 })
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

  test("resume through the DB completes with the same combined log (jh.md §6b)", async () => {
    // A 2-leaf scenario; save the state at the FIRST checkpoint, then load it and resume.
    const replies = () => [
      JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: [leaf("a", "a1"), leaf("b", "b1")] }),
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
          mkDeps([JSON.stringify(leaf("b", "b1"))], [okObs("b1")], undefined, JhArtifact.memory(reloaded!.state.artifacts)),
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
const leaf = (goal: string, produce: string) => ({ goal, size: "atomic", tool: "note", args: { text: "x" }, success: "ok", check: { type: "artifact_present" }, produces: [{ id: produce, type: "note" }] })
const okObs = (id: string): JhBasicTools.Observation => ({ ok: true, output: "o", artifacts: new Map([[id, "x"]]) })
function mkDeps(replies: string[], observations: JhBasicTools.Observation[], checkpoint?: (s: JhEngine.State) => Effect.Effect<void>, artifacts = JhArtifact.memory()): JhEngine.Deps {
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
