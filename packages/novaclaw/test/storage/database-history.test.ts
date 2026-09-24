import { expect, test } from "bun:test"
import { Database } from "@novaclaw/core/database/database"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { prune } from "../../src/storage/database-history"

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
