import { expect, test } from "bun:test"
import { Effect } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import migration from "@novaclaw/core/database/migration/20260927214353_add_scratch_horizon"

const structure = (fresh: boolean) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      if (fresh) yield* DatabaseMigration.apply(db)
      else {
        yield* db.run("CREATE TABLE session (id text PRIMARY KEY)")
        yield* DatabaseMigration.applyOnly(db, [migration])
        yield* DatabaseMigration.applyOnly(db, [migration])
      }
      return {
        columns: yield* db.all("PRAGMA table_info(agent_scratch_horizon)"),
        foreignKeys: yield* db.all("PRAGMA foreign_key_list(agent_scratch_horizon)"),
        indexes: yield* db.all("PRAGMA index_list(agent_scratch_horizon)"),
      }
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

test("fresh and upgraded SQLite stores have the same officer scratch component", async () => {
  const fresh = await structure(true)
  expect(fresh.columns).toHaveLength(6)
  expect(fresh.foreignKeys).toHaveLength(1)
  expect(await structure(false)).toEqual(fresh)
})
