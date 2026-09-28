import { expect, test } from "bun:test"
import { Database } from "@novaclaw/core/database/database"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { layer, prune } from "../../src/storage/database-history"

test("periodic history cleanup waits for its interval before scanning stored events", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('scheduled-chat', 2)`)
      const data = JSON.stringify({ info: { summary: { diffs: [{ file: "a", patch: "old diff" }] } } })
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES
      ('scheduled-1', 'scheduled-chat', 1, 'session.updated.2', ${data}),
      ('scheduled-2', 'scheduled-chat', 2, 'session.updated.2', ${data})`)
      const remaining = Effect.gen(function* () {
        const rows = yield* db.all<{ count: number }>(sql`SELECT count(*) AS count FROM event
        WHERE aggregate_id = 'scheduled-chat' AND json_type(data, '$.info.summary.diffs') IS NOT NULL`)
        return rows[0]?.count
      })
      yield* Layer.build(layer.pipe(Layer.provide(SettingsConfigStore.layer)))
      yield* TestClock.adjust("14 minutes")
      expect(yield* remaining).toBe(2)
      yield* TestClock.adjust("1 minute")
      expect(yield* remaining).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(Database.layerFromPath(":memory:")), Effect.provide(TestClock.layer())),
  )
})

test("history cleanup removes older diff copies and keeps the latest replay state", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db.run(sql`INSERT INTO event_sequence (aggregate_id, seq) VALUES ('chat-a', 3), ('chat-b', 1)`)
    const largeDiff = "x".repeat(200_000)
    const events = [
      { id: "a1", aggregate: "chat-a", seq: 1, title: "early", diff: largeDiff },
      { id: "a2", aggregate: "chat-a", seq: 2, title: "current", diff: largeDiff },
      { id: "a3", aggregate: "chat-a", seq: 3, title: "later", diff: undefined },
      { id: "b1", aggregate: "chat-b", seq: 1, title: "other", diff: largeDiff },
    ]
    for (const event of events) {
      const data = JSON.stringify({ sessionID: event.aggregate, info: { title: event.title, summary: { files: 1, diffs: event.diff ? [{ file: "a", patch: event.diff }] : undefined } } })
      yield* db.run(sql`INSERT INTO event (id, aggregate_id, seq, type, data) VALUES (${event.id}, ${event.aggregate}, ${event.seq}, 'session.updated.2', ${data})`)
    }
    const result = yield* prune(db, 0)
    expect(result.prunedEvents).toBe(1)
    const rows = (yield* db.all(sql`SELECT id, data FROM event ORDER BY id`)) as { id: string; data: string }[]
    const byId = Object.fromEntries(rows.map((row) => [row.id, JSON.parse(row.data) as { info: { title: string; summary: { diffs?: unknown[] } } }]))
    expect(byId.a1?.info.summary.diffs).toBeUndefined()
    expect(byId.a2?.info.summary.diffs).toHaveLength(1)
    expect(byId.a3?.info.title).toBe("later")
    expect(byId.b1?.info.summary.diffs).toHaveLength(1)
    expect(result.afterBytes).toBeLessThan(result.beforeBytes)
  }).pipe(Effect.provide(Database.layerFromPath(":memory:"))))
})
