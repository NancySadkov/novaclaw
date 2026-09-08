import path from "node:path"
import { describe, expect, test } from "bun:test"
import { Database as BunSqlite } from "bun:sqlite"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { sql } from "drizzle-orm"
import { Cause, Effect, Exit } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { migrations } from "@novaclaw/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

/**
 * ⚠️ `expect(Exit.isFailure(x)).toBe(true)` asserts at RUNTIME and narrows nothing for the
 * compiler, so every `.cause` read after one is a type error. This asserts and narrows in one step,
 * so the reads below are checked rather than cast.
 */
function failureOf<A, E>(exit: Exit.Exit<A, E>): Cause.Cause<E> {
  if (!Exit.isFailure(exit)) throw new Error("expected a failure, got a success")
  return exit.cause
}

/**
 * **Two NovaClaws on one database file.**
 *
 * Not a hypothetical shape: the desktop's Electron utilityProcess server and a `novaclaw` CLI run in
 * a terminal open the same default-channel file, as do a `serve` and a `novaclaw run`. The migration
 * was serialised by an in-process `Semaphore`, which is exactly as much protection as no lock at all
 * once the second opener is a second PROCESS.
 *
 * ⚠️ **Two CONNECTIONS is the honest probe, and it is the same probe as two processes.** Each
 * `sqliteLayer({ filename })` build opens its own native handle with its own `Semaphore(1)`, so
 * nothing in this process is shared between them — they contend through the file, which is the whole
 * mechanism under test. Spawning two `bun` children would add a process boundary and no new
 * contention, and would put the failure somewhere the harness discards it.
 *
 * Both halves of the defect are here, because the second is the one a user meets: they race, AND the
 * loser is told the wrong thing about why it stopped.
 */

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Db = Effect.Success<typeof makeDatabase>

/** One independent connection to `file`, disposed when the body ends. Never throws; returns the Exit. */
const onConnection = <A, E>(file: string, busyTimeoutMs: number, body: (db: Db) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const db = yield* makeDatabase
      // Ignored, not asserted: WAL is persistent in the file, so the second connection re-declaring
      // it is a no-op — and a no-op that must not fail the probe when another connection is mid-write.
      yield* db.run("PRAGMA journal_mode = WAL").pipe(Effect.ignore)
      yield* db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
      return yield* body(db)
    }).pipe(Effect.provide(sqliteLayer({ filename: file })), Effect.scoped),
  )

const tableNames = (db: Db) =>
  db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)

/** What is actually in the file afterwards, read by a third party that took part in nothing. */
function inspect(file: string) {
  const db = new BunSqlite(file, { readonly: true })
  try {
    return {
      tables: (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      ),
      recorded: (db.query("SELECT id FROM migration").all() as { id: string }[]).map((row) => row.id),
    }
  } finally {
    db.close()
  }
}

/**
 * Hold the database's write lock the way another NovaClaw mid-upgrade holds it.
 *
 * ⚠️ `async` and `await body()`, not a synchronous `try/finally` around a promise-returning body:
 * the latter releases the lock the instant the body returns its (unresolved) promise, so every
 * assertion inside would run against an unlocked file and pass for the wrong reason.
 */
async function withWriteLock<A>(file: string, body: () => Promise<A>): Promise<A> {
  const holder = new BunSqlite(file)
  holder.run("PRAGMA busy_timeout = 0")
  holder.run("BEGIN IMMEDIATE")
  try {
    return await body()
  } finally {
    try {
      holder.run("ROLLBACK")
    } finally {
      holder.close()
    }
  }
}

describe("two openers of one database file", () => {
  test("🔴 the twin: a decision read OUTSIDE the write transaction is stale by the time it is acted on", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")

    // Step 1 — process A does what `apply` used to do first: a plain read of `sqlite_master`,
    // outside any transaction. Under WAL nothing blocks it and nothing records that it happened.
    const seen = await onConnection(file, 5_000, tableNames)
    if (!Exit.isSuccess(seen)) throw new Error(`the probe read failed:\n${Cause.pretty(seen.cause)}`)
    expect(seen.value).toEqual([])

    // Step 2 — process B installs the whole schema and commits, in the window A left open.
    const winner = await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db))
    expect(Exit.isSuccess(winner)).toBe(true)

    // Step 3 — A now acts on what it read: "nothing is installed, install it". This is the write arm
    // the stale decision authorises, and it is the loser's error verbatim.
    const loser = await onConnection(file, 5_000, (db) =>
      db.run(sql`CREATE TABLE ${sql.identifier("migration")} (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)`),
    )
    expect(Cause.pretty(failureOf(loser))).toMatch(/already exists/i)
  })

  test("the decision is taken under the write lock, so the second opener is refused rather than misled", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    expect(Exit.isSuccess(await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db)))).toBe(true)

    const outcome = await withWriteLock(file, async () => {
      // ⚠️ The control that gives the arm below its meaning: a plain READ is not blocked, which is
      // precisely why deciding from one is unsafe. If this ever starts failing, the test below is
      // measuring SQLite's reader-blocking rather than this fix.
      const read = await onConnection(file, 50, tableNames)
      expect(Exit.isSuccess(read)).toBe(true)

      // `apply` is blocked — at BEGIN, before it can read anything it might act on.
      return await onConnection(file, 50, (db) => DatabaseMigration.apply(db))
    })
    expect(Cause.pretty(failureOf(outcome))).toMatch(/SQLITE_BUSY|database is locked/i)

    // Nothing the loser did reached the file, and once the other process lets go the same call
    // succeeds — with every migration recorded exactly once, not twice.
    expect(Exit.isSuccess(await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db)))).toBe(true)
    const after = inspect(file)
    expect(after.tables).toContain("session")
    expect(after.recorded.length).toBe(migrations.length)
    expect(new Set(after.recorded).size).toBe(after.recorded.length)
  })

  test("the CONTROL: one opener on its own is unchanged, and a second run of it is a no-op", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")

    expect(Exit.isSuccess(await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db)))).toBe(true)
    const first = inspect(file)
    expect(first.tables).toContain("session")
    expect(first.tables).toContain("migration")
    expect(first.recorded.length).toBe(migrations.length)

    // Re-opening the same file re-runs `apply`, which must record nothing new.
    expect(Exit.isSuccess(await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db)))).toBe(true)
    expect(inspect(file)).toEqual(first)
  })
})

// ── the half a user actually meets: what the loser is TOLD ──────────────────────────────────────
describe("the refusal names the real cause", () => {
  test("🔴 contention refuses as `busy` and never sends the user to downgrade", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    expect(Exit.isSuccess(await onConnection(file, 5_000, (db) => DatabaseMigration.apply(db)))).toBe(true)

    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    const exit = await withWriteLock(file, async () => {
      process.stderr.write = ((chunk: unknown) => {
        written.push(String(chunk))
        return true
      }) as typeof process.stderr.write
      try {
        return await Effect.runPromiseExit(
          Effect.gen(function* () {
            return (yield* Database.Service).db
          }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
        )
      } finally {
        process.stderr.write = original
      }
    })

    const cause = failureOf(exit)
    const squashed = Cause.squash(cause)
    if (!(squashed instanceof Database.Unusable))
      throw new Error(`expected a named refusal, got:
${Cause.pretty(cause)}`)

    // The fault this used to be reported as — a structurally valid database with a full `migration`
    // table looks, to `sqlite_master`, exactly like a healthy one whose upgrade went wrong.
    expect(squashed.fault.kind).not.toBe("migration")
    expect(squashed.fault.kind).toBe("busy")
    expect(squashed.fault.path).toBe(file)

    const stderr = written.join("")
    expect(stderr).toContain("Another NovaClaw is already using this database file")
    expect(stderr).toContain("Nothing was moved, renamed or deleted")
    // 🔴 The sentence the old classification produced, and the reason this kind exists.
    expect(stderr).not.toContain("Install the NovaClaw version you were running before")
    expect(stderr).toContain("Close the other one")
  }, 20_000)
})
