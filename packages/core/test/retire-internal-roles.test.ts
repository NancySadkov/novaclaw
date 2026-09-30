import { expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { DatabaseMigration } from "../src/database/migration"
import retirement from "../src/database/migration/20260930100000_retire_internal_roles"

test("retirement archives obsolete trees, preserves transcripts and officers, and repairs messenger ownership", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE session (id TEXT PRIMARY KEY, agent TEXT, parent_id TEXT, time_archived INTEGER)`)
      yield* db.run(sql`CREATE TABLE agent_config (name TEXT PRIMARY KEY, layers TEXT)`)
      yield* db.run(sql`CREATE TABLE agent_retirement (agent TEXT, retired_at INTEGER)`)
      yield* db.run(sql`CREATE TABLE agent_setting (key TEXT PRIMARY KEY, value TEXT)`)
      yield* db.run(sql`CREATE TABLE messenger_account (id TEXT PRIMARY KEY, agent_id TEXT)`)
      yield* db.run(
        sql`INSERT INTO session VALUES ('r','recipe',NULL,NULL), ('c','nova','r',NULL), ('g','nova','c',NULL), ('n','nova',NULL,NULL), ('a','explore',NULL,42)`,
      )
      yield* db.run(sql`INSERT INTO agent_config VALUES ('general','[]'), ('messenger','[]'), ('manager','[]')`)
      yield* db.run(sql`INSERT INTO agent_setting VALUES ('default_agent','"general"')`)
      yield* db.run(sql`INSERT INTO messenger_account VALUES ('old','messenger'), ('owned','manager')`)
      yield* DatabaseMigration.applyOnly(db, [retirement])
      yield* DatabaseMigration.applyOnly(db, [retirement])
      const sessions = yield* db.all<{ id: string; time_archived: number | null }>(sql`SELECT * FROM session`)
      expect(sessions).toHaveLength(5)
      for (const id of ["r", "c", "g"]) expect(sessions.find((row) => row.id === id)?.time_archived).toBeGreaterThan(0)
      expect(sessions.find((row) => row.id === "a")?.time_archived).toBe(42)
      expect(sessions.find((row) => row.id === "n")?.time_archived).toBeNull()
      expect(yield* db.all(sql`SELECT name FROM agent_config`)).toEqual([{ name: "manager" }])
      expect(yield* db.all(sql`SELECT * FROM agent_setting`)).toEqual([])
      expect(yield* db.all(sql`SELECT agent FROM agent_retirement ORDER BY agent`)).toEqual(
        ["explore", "general", "messenger", "recipe"].map((agent) => ({ agent })),
      )
      expect(yield* db.all(sql`SELECT * FROM messenger_account ORDER BY id`)).toEqual([
        { id: "old", agent_id: "nova" },
        { id: "owned", agent_id: "manager" },
      ])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
