export * as DatabaseMigration from "./migration"

import { sql } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import type { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { migrations } from "./migration.gen"
import schema from "./schema.gen"

type Database = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0]
const lock = Semaphore.makeUnsafe(1)

export type Migration = {
  id: string
  up: (tx: Transaction) => Effect.Effect<void, unknown>
}

/**
 * 🔴 **The decision and the writes it authorises share ONE write transaction, and it must stay that
 * way.** `lock` above is an in-process `Semaphore`, and a database file is not an in-process thing:
 * the desktop's Electron utilityProcess server and a `novaclaw` CLI run in a terminal are two
 * processes on the same default-channel file, as are a `serve` and a `novaclaw run`.
 *
 * Read outside a write transaction, `SELECT name FROM sqlite_master` answers a question that is
 * already stale by the time it is acted on: under WAL a reader is never blocked by a writer, so both
 * processes can see "no tables yet" or "migration N+1 is not recorded", and both then run it. The
 * loser's `CREATE TABLE session` hits *table already exists*, or its `ALTER TABLE … ADD COLUMN` hits
 * *duplicate column name* — a concurrency fault wearing a schema fault's clothes, which is exactly
 * what `Database.describeMigrationFailure` then mis-describes as *our bug against your data*.
 *
 * `behavior: "immediate"` is what closes it, and it closes it at the only layer that spans
 * processes: SQLite issues `BEGIN IMMEDIATE`, which takes the database's WRITE lock before the first
 * statement runs, so the second process either waits (`PRAGMA busy_timeout`, set in `database.ts`
 * before this is called) and then reads the winner's COMMITTED result, or gives up with
 * `SQLITE_BUSY` — never proceeds on a snapshot the other process is about to move.
 *
 * ⚠️ The inner `db.transaction`s — this function's fresh-install arm and `applyOnly`'s per-migration
 * one — become SAVEPOINTs on this same connection rather than second transactions, because
 * `SqlClient` resolves each statement's connection from `transactionService` in the fiber context.
 * (Same mechanism `config-store-write.ts` relies on to make one `/config` write all-or-nothing.) Two
 * consequences worth stating: a failure now rolls the WHOLE chain back rather than leaving it at the
 * last completed step — strictly closer to *"exactly as the last working version left it"*, which is
 * what the refusal already promises — and no store call inside may run on a FORKED fiber, which
 * would not inherit the transaction and would deadlock on the connection permit this holds.
 */
export function apply(db: Database) {
  return lock.withPermit(
    db.transaction(
      () =>
        Effect.gen(function* () {
          const tables = yield* db.all<{ name: string }>(
            sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
          )
          if (tables.some((table) => table.name === "session")) return yield* applyOnly(db, migrations)
          if (tables.length > 0) return yield* Effect.die("Database is not empty and has no session table")
          yield* db.transaction((tx) =>
            Effect.gen(function* () {
              yield* schema.up(tx)
              yield* tx.run(
                sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
              )
              yield* Effect.forEach(migrations, (migration) =>
                tx.run(
                  sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
                ),
              )
            }),
          )
        }),
      { behavior: "immediate" },
    ),
  )
}

export function applyOnly(db: Database, input: Migration[]) {
  return Effect.gen(function* () {
    yield* db.run(
      sql`CREATE TABLE IF NOT EXISTS ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`,
    )
    let completed = new Set(
      (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
    )
    if (completed.size === 0) {
      // Existing installs used Drizzle's migration journal. Seed the new
      // journal once so TypeScript migrations don't replay old SQL.
      if (
        yield* db.get(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${"__drizzle_migrations"}`)
      ) {
        yield* db.run(sql`
          INSERT OR IGNORE INTO ${sql.identifier("migration")} (id, time_completed)
          SELECT name, ${Date.now()}
          FROM ${sql.identifier("__drizzle_migrations")}
          WHERE name IS NOT NULL
        `)
        completed = new Set(
          (yield* db.all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)).map((row) => row.id),
        )
      }
    }

    for (const migration of input) {
      if (completed.has(migration.id)) continue
      yield* db.transaction((tx) =>
        Effect.gen(function* () {
          yield* migration.up(tx)
          yield* tx.run(
            sql`INSERT INTO ${sql.identifier("migration")} (id, time_completed) VALUES (${migration.id}, ${Date.now()})`,
          )
        }),
      )
    }
  })
}
