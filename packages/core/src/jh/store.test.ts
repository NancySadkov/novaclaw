import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
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

  test("load unknown id → undefined; list reflects status", async () => {
    const result = await withDb((db) =>
      Effect.gen(function* () {
        const missing = yield* JhStore.load(db, "nope")
        yield* JhStore.save(db, { id: "a", goal: "ga", status: "running", state: sampleState(), now: 1 })
        yield* JhStore.save(db, { id: "b", goal: "gb", status: "blocked", state: sampleState(), now: 2 })
        const listed = yield* JhStore.list(db)
        return { missing, listed }
      }),
    )
    expect(result.missing).toBeUndefined()
    expect(result.listed.length).toBe(2)
    expect(new Set(result.listed.map((r) => r.status))).toEqual(new Set(["running", "blocked"]))
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
