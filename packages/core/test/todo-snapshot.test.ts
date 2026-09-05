import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable, TodoSnapshotTable, TodoTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

/**
 * The declared plan, frozen when an attempt opens (`` V1).
 *
 * 🔴 The defect this exists to prevent is silent and only visible later: the `todo` list is per
 * SESSION and the model edits it WHILE the attempt runs, so a receipt pointing at the live list
 * names the plan as it ENDED and calls it what was declared. Nothing about that looks wrong — the
 * receipt is well-formed, the items are real, and the reader has no way to tell.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, SessionExecutionAttempt.node])))

const seed = (id: SessionSchema.ID, items: Array<{ content: string; status: string; position: number }>) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    yield* db
      .insert(SessionTable)
      .values({ id, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
    for (const item of items)
      yield* db
        .insert(TodoTable)
        .values({
          session_id: id,
          content: item.content,
          status: item.status,
          priority: "medium",
          position: item.position,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
  })

const snapshotOf = (attemptID: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    return yield* db
      .select({ content: TodoSnapshotTable.content, status: TodoSnapshotTable.status })
      .from(TodoSnapshotTable)
      .where(eq(TodoSnapshotTable.attempt_id, attemptID))
      .orderBy(asc(TodoSnapshotTable.position))
      .all()
      .pipe(Effect.orDie)
  })

describe("the declared plan is frozen per attempt", () => {
  it.effect("captures the list, in order, when the attempt opens", () =>
    Effect.gen(function* () {
      const id = SessionSchema.ID.make("ses_plan")
      yield* seed(id, [
        { content: "read the failing test", status: "completed", position: 0 },
        { content: "fix the parser", status: "in_progress", position: 1 },
        { content: "run the gate", status: "pending", position: 2 },
      ])
      const attempt = yield* SessionExecutionAttempt.Service
      const lease = yield* attempt.start(id, "owner-1")
      // Order is the point: a plan whose steps come back in storage order is not a plan.
      expect((yield* snapshotOf(lease.attemptID)).map((row) => row.content)).toEqual([
        "read the failing test",
        "fix the parser",
        "run the gate",
      ])
    }),
  )

  it.effect("🔴 EDITING the live list afterwards does not change the frozen plan", () =>
    Effect.gen(function* () {
      // The whole reason this table exists. Without it a receipt would report the third item as
      // completed and the second as deleted — a truthful description of the list, and a false
      // description of what was DECLARED.
      const id = SessionSchema.ID.make("ses_edit")
      yield* seed(id, [
        { content: "original step", status: "pending", position: 0 },
        { content: "second step", status: "pending", position: 1 },
      ])
      const attempt = yield* SessionExecutionAttempt.Service
      const lease = yield* attempt.start(id, "owner-1")

      const { db } = yield* Database.Service
      yield* db
        .update(TodoTable)
        .set({ content: "rewritten", status: "completed" })
        .where(eq(TodoTable.session_id, id))
        .run()
        .pipe(Effect.orDie)

      const frozen = yield* snapshotOf(lease.attemptID)
      expect(frozen.map((row) => row.content)).toEqual(["original step", "second step"])
      expect(frozen.every((row) => row.status === "pending")).toBe(true)
    }),
  )

  it.effect("🔴 a SECOND attempt gets its own plan, and the first one survives", () =>
    Effect.gen(function* () {
      // `session_execution.attempt_id` is overwritten in place on the next attempt, which is exactly
      // why this table carries no foreign key to it — a reference would cascade the older attempt's
      // plan away, and the older attempt's plan surviving is the point.
      const id = SessionSchema.ID.make("ses_two")
      yield* seed(id, [{ content: "first plan", status: "pending", position: 0 }])
      const attempt = yield* SessionExecutionAttempt.Service
      const first = yield* attempt.start(id, "owner-1")

      const { db } = yield* Database.Service
      yield* db
        .update(TodoTable)
        .set({ content: "second plan" })
        .where(eq(TodoTable.session_id, id))
        .run()
        .pipe(Effect.orDie)
      const second = yield* attempt.start(id, "owner-2")

      expect(first.attemptID).not.toBe(second.attemptID)
      expect((yield* snapshotOf(first.attemptID)).map((row) => row.content)).toEqual(["first plan"])
      expect((yield* snapshotOf(second.attemptID)).map((row) => row.content)).toEqual(["second plan"])
    }),
  )

  it.effect("a session with no plan records none — an empty plan is not an error", () =>
    Effect.gen(function* () {
      const id = SessionSchema.ID.make("ses_empty")
      yield* seed(id, [])
      const attempt = yield* SessionExecutionAttempt.Service
      const lease = yield* attempt.start(id, "owner-1")
      expect(yield* snapshotOf(lease.attemptID)).toEqual([])
    }),
  )
})
