export * as SessionTodo from "./todo"

import { and, asc, eq } from "drizzle-orm"
import { Context, Effect, Layer, Schema } from "effect"
import { SessionTodo } from "@novaclaw/schema/session-todo"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { SessionSchema } from "./schema"
import { SessionComponentTable, TodoTable } from "./sql"
import { SessionComponentRegistry } from "./component-registry"

export const Info = SessionTodo.Info
export type Info = typeof Info.Type
export const Event = SessionTodo.Event

export interface Interface {
  readonly update: (input: {
    readonly sessionID: SessionSchema.ID
    readonly todos: ReadonlyArray<Info>
  }) => Effect.Effect<void>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Info>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionTodo") {}

/**
 * Deps-taking read seam (cf. `SessionRead` / `SessionMessageRead`): the todo list is a plain
 * `TodoTable` read by `session_id` with NO Location dependency, so a caller holding `db` can serve
 * it without resolving the location-scoped `Service`. The F1f httpapi todo route uses this instead
 * of the V1 `Todo.Service` (both read the same table).
 */
export const readTodos = (
  db: Database.Interface["db"],
  sessionID: SessionSchema.ID,
): Effect.Effect<ReadonlyArray<Info>> =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ value: SessionComponentTable.value })
      .from(SessionComponentTable)
      .where(and(eq(SessionComponentTable.session_id, sessionID), eq(SessionComponentTable.kind, "plan")))
      .orderBy(asc(SessionComponentTable.component_id))
      .all()
      .pipe(Effect.orDie)
    if (rows.length > 0)
      return rows.map(({ value }) => {
        const step = Schema.decodeUnknownSync(SessionComponentRegistry.PlanStep)(value)
        return { content: step.text, status: step.status, priority: step.priority ?? "medium" }
      })

    // Existing databases may still carry the pre-component checklist. It is read-only from here:
    // the next update below writes the canonical plan rows and deletes these legacy rows.
    return yield* db
      .select()
      .from(TodoTable)
      .where(eq(TodoTable.session_id, sessionID))
      .orderBy(asc(TodoTable.position))
      .all()
      .pipe(
        Effect.orDie,
        Effect.map((legacy) =>
          legacy.map((row) => ({ content: row.content, status: row.status, priority: row.priority })),
        ),
      )
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service

    const update = Effect.fn("SessionTodo.update")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly todos: ReadonlyArray<Info>
    }) {
      yield* db
        .transaction((tx) =>
          Effect.gen(function* () {
            yield* tx
              .delete(SessionComponentTable)
              .where(and(eq(SessionComponentTable.session_id, input.sessionID), eq(SessionComponentTable.kind, "plan")))
              .run()
            yield* tx.delete(TodoTable).where(eq(TodoTable.session_id, input.sessionID)).run()
            if (input.todos.length === 0) return
            yield* tx
              .insert(SessionComponentTable)
              .values(
                input.todos.map((todo, position) => ({
                  session_id: input.sessionID,
                  kind: "plan",
                  component_id: SessionComponentRegistry.planComponentID(position),
                  schema_version: 1,
                  lifetime: "entity" as const,
                  value: {
                    position,
                    text: todo.content,
                    status: todo.status,
                    priority: todo.priority,
                    verdict: null,
                  },
                  time_created: Date.now(),
                  time_updated: Date.now(),
                })),
              )
              .run()
          }),
        )
        .pipe(Effect.orDie)
      yield* events.publish(Event.Updated, input)
    })

    const get = Effect.fn("SessionTodo.get")(function* (sessionID: SessionSchema.ID) {
      return yield* readTodos(db, sessionID)
    })

    return Service.of({ update, get })
  }),
)

export const defaultLayer = layer.pipe(Layer.provide(EventV2.defaultLayer), Layer.provide(Database.defaultLayer))

export const node = makeLocationNode({ service: Service, layer, deps: [EventV2.node, Database.node] })
