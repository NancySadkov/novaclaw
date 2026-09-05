import { JhController } from "@novaclaw/core/jh/controller"
import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { EventV2 } from "@novaclaw/core/event"
import { Project } from "@novaclaw/core/project"
import { JhTree } from "@novaclaw/core/jh/tree"
import type { JhEngine } from "@novaclaw/core/jh/engine"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionComponentTable, SessionTable, TodoTable } from "@novaclaw/core/session/sql"
import { SessionTodo } from "@novaclaw/core/session/todo"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionPlan } from "@novaclaw/core/session/plan"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionComponentRegistry.node, SessionTodo.node])),
)
const sessionID = SessionV2.ID.make("ses_todo_test")

const setup = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      slug: "todo",
      directory: "/project",
      title: "todo",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
})

describe("SessionTodo", () => {
  it.effect("replaces persisted todos in order and publishes updates", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const components = yield* SessionComponentRegistry.Service
      const events = yield* EventV2.Service
      const todos = yield* SessionTodo.Service
      const published = new Array<EventV2.Payload>()
      const unsubscribe = yield* events.listen((event) =>
        Effect.sync(() => {
          if (event.type === SessionTodo.Event.Updated.type) published.push(event)
        }),
      )
      yield* Effect.addFinalizer(() => unsubscribe)

      yield* todos.update({
        sessionID,
        todos: [
          { content: "second", status: "pending", priority: "low" },
          { content: "first", status: "in_progress", priority: "high" },
        ],
      })
      expect(yield* todos.get(sessionID)).toEqual([
        { content: "second", status: "pending", priority: "low" },
        { content: "first", status: "in_progress", priority: "high" },
      ])
      expect(
        (yield* db
          .select()
          .from(SessionComponentTable)
          .where(eq(SessionComponentTable.kind, "plan"))
          .orderBy(asc(SessionComponentTable.component_id))
          .all()
          .pipe(Effect.orDie)).map((row) => ({ id: row.component_id, value: row.value })),
      ).toEqual([
        {
          id: "step-00000000",
          value: { position: 0, text: "second", status: "pending", priority: "low", verdict: null },
        },
        {
          id: "step-00000001",
          value: { position: 1, text: "first", status: "in_progress", priority: "high", verdict: null },
        },
      ])
      expect(yield* db.select().from(TodoTable).all().pipe(Effect.orDie)).toEqual([])

      yield* todos.update({ sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] })
      expect(yield* todos.get(sessionID)).toEqual([{ content: "replacement", status: "completed", priority: "medium" }])

      yield* todos.update({ sessionID, todos: [] })
      expect(yield* todos.get(sessionID)).toEqual([])
      expect(published.map((event) => event.data)).toEqual([
        {
          sessionID,
          todos: [
            { content: "second", status: "pending", priority: "low" },
            { content: "first", status: "in_progress", priority: "high" },
          ],
        },
        { sessionID, todos: [{ content: "replacement", status: "completed", priority: "medium" }] },
        { sessionID, todos: [] },
      ])
    }),
  )

  it.effect("projects the JH tree into the same plan rows with system-owned verdicts", () =>
    Effect.gen(function* () {
      yield* setup
      const { db } = yield* Database.Service
      const components = yield* SessionComponentRegistry.Service
      const draft = {
        goal: "Run the focused test",
        size: "atomic" as const,
        tool: "run",
        args: { command: "bun test" },
        check: { type: "run" as const, command: "bun test" },
      }
      const tree = JhTree.setStatus(JhTree.create(draft), JhTree.ROOT_ID, "committed")
      const state: JhEngine.State = {
        tree,
        artifacts: [],
        log: [
          { seq: 0, type: "verification", step: "root", ok: true, detail: "bun test exited 0" },
          { seq: 1, type: "committed", step: "root" },
        ],
        controller: JhController.create(),
        telemetry: new Map(),
      }
      yield* SessionPlan.projectJh(components, { sessionID, goal: "Ship C8", state, now: 456 })

      const rows = yield* db
        .select()
        .from(SessionComponentTable)
        .orderBy(asc(SessionComponentTable.kind), asc(SessionComponentTable.component_id))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => ({ kind: row.kind, value: row.value }))).toEqual([
        { kind: "goal", value: { text: "Ship C8" } },
        {
          kind: "plan",
          value: {
            position: 0,
            text: "Run the focused test",
            status: "completed",
            verdict: {
              check: '{"type":"run","command":"bun test"}',
              passedAt: 456,
              evidence: "bun test exited 0",
            },
          },
        },
      ])

      yield* SessionPlan.projectJh(components, {
        sessionID,
        goal: "Ship C8",
        state: {
          ...state,
          log: [
            { seq: 0, type: "verification", step: "root", ok: false, detail: "exit 1" },
            { seq: 1, type: "committed_best_effort", step: "root", reason: "exit 1" },
          ],
        },
        now: 789,
      })
      const bestEffort = yield* db
        .select({ value: SessionComponentTable.value })
        .from(SessionComponentTable)
        .where(eq(SessionComponentTable.kind, "plan"))
        .get()
        .pipe(Effect.orDie)
      expect(bestEffort?.value).toMatchObject({ status: "blocked", verdict: null })
    }),
  )
})
