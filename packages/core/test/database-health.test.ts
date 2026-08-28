import { describe, expect, test } from "bun:test"
import { testEffect } from "./lib/effect"
import { Database as Sqlite } from "bun:sqlite"
import { Effect } from "effect"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Database } from "@novaclaw/core/database/database"
import { DatabaseHealth } from "@novaclaw/core/database/health"

const dir = mkdtempSync(join(tmpdir(), "novaclaw-dbhealth-"))

/** A real file, because `quick_check` reads PAGES — an in-memory fake cannot be corrupted. */
const makeDb = (name: string, rows = 200) => {
  const path = join(dir, name)
  const db = new Sqlite(path)
  db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)")
  db.run("CREATE INDEX t_v ON t (v)")
  for (let i = 0; i < rows; i++) db.run("INSERT INTO t (v) VALUES (?)", [`row-${i}`])
  db.run("PRAGMA wal_checkpoint(TRUNCATE)")
  return { db, path }
}

/** `Effect.try` takes `{ try, catch }` in effect@4 — a bare thunk silently becomes a defect. */
const attempt = <A>(thunk: () => A) =>
  Effect.suspend(() => {
    try {
      return Effect.succeed(thunk())
    } catch (error) {
      return Effect.die(error)
    }
  })

const executorFor = (db: Sqlite): DatabaseHealth.Executor => ({
  run: (sql) => attempt(() => db.run(sql)),
  rows: (sql) => attempt(() => db.query(sql).all() as Record<string, unknown>[]),
})

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

const it = testEffect(Database.defaultLayer)

describe("database health", () => {
  test("a healthy store reports ok", () => {
    const { db } = makeDb("healthy.db")
    expect(run(DatabaseHealth.check(executorFor(db)))).toEqual({ status: "ok" })
    db.close()
  })

  // ⚠️ THE assertion. A health check that cannot detect damage is worse than none — it is a green
  // tick over a broken store, on the screen someone opens when they already suspect their data is
  // damaged. So this corrupts real pages and requires the probe to say so.
  test("DETECTS a corrupted file — the negative control that makes the green one mean something", () => {
    const { db, path } = makeDb("corrupt.db")
    db.close()
    const bytes = readFileSync(path)
    // Scribble over the middle of the file, past the header, where table/index pages live.
    for (let offset = 4096; offset < Math.min(bytes.length, 16384); offset += 7) bytes[offset] = 0x5a
    writeFileSync(path, bytes)
    const reopened = new Sqlite(path)
    const report = run(DatabaseHealth.check(executorFor(reopened)))
    expect(report.status).not.toBe("ok")
    // `damaged` when SQLite answered, `unknown` when it could not read enough to answer — either is
    // honest, and a silent "ok" is the only unacceptable outcome.
    expect(["damaged", "unknown"]).toContain(report.status)
    expect(report.detail).toBeDefined()
    reopened.close()
  })

  // ⚠️ A probe that THREW says nothing about the pages. Reporting "damaged" because we could not ask
  // is a false description of someone's data.
  test("an unreadable probe is UNKNOWN, never damaged", () => {
    const executor: DatabaseHealth.Executor = {
      run: () => Effect.die(new Error("handle closed")),
      rows: () => Effect.die(new Error("handle closed")),
    }
    const report = run(DatabaseHealth.check(executor))
    expect(report.status).toBe("unknown")
    expect(report.detail).toContain("could not run")
  })

  test("no rows back is unknown, not ok", () => {
    const executor: DatabaseHealth.Executor = { run: () => Effect.void, rows: () => Effect.succeed([]) }
    expect(run(DatabaseHealth.check(executor)).status).toBe("unknown")
  })
})

describe("database healing", () => {
  // A healthy store must not be reindexed every time a health screen is opened.
  test("does NOT run repairs on a healthy store", () => {
    const { db } = makeDb("healthy-heal.db")
    const healed = run(DatabaseHealth.heal(executorFor(db)))
    expect(healed.status).toBe("ok")
    expect(healed.attempted).toEqual([])
    expect(healed.repaired).toBe(false)
    db.close()
  })

  test("attempts every repair when the store is not ok, and names each outcome", () => {
    const failures: string[] = []
    const executor: DatabaseHealth.Executor = {
      run: (sql) => {
        failures.push(sql)
        return sql === "REINDEX" ? Effect.die(new Error("disk full")) : Effect.void
      },
      rows: () => Effect.succeed([{ quick_check: "database disk image is malformed" }]),
    }
    const healed = run(DatabaseHealth.heal(executor))
    expect(failures).toEqual([...DatabaseHealth.REPAIRS])
    expect(healed.attempted.map((a) => a.ok)).toEqual([true, true, false])
    expect(healed.attempted[2]!.error).toContain("disk full")
    // Still damaged after — so `repaired` must be false however many repairs "succeeded".
    expect(healed.status).toBe("damaged")
    expect(healed.repaired).toBe(false)
  })

  // ⚠️ The claim that must never be optimistic: `repaired` reflects the RE-CHECK, not the fact that
  // the repair statements ran without throwing.
  test("reports repaired only on a damaged → ok transition", () => {
    let answered = 0
    const executor: DatabaseHealth.Executor = {
      run: () => Effect.void,
      rows: () => Effect.succeed([{ v: answered++ === 0 ? "malformed" : "ok" }]),
    }
    const healed = run(DatabaseHealth.heal(executor))
    expect(healed.status).toBe("ok")
    expect(healed.repaired).toBe(true)
  })

  test("unknown → ok is healthy but NOT reported as a repair", () => {
    let first = true
    const executor: DatabaseHealth.Executor = {
      run: () => Effect.void,
      rows: () => {
        if (first) {
          first = false
          return Effect.die(new Error("locked"))
        }
        return Effect.succeed([{ v: "ok" }])
      },
    }
    const healed = run(DatabaseHealth.heal(executor))
    expect(healed.status).toBe("ok")
    // The probe started working; nothing proves a repair caused it.
    expect(healed.repaired).toBe(false)
  })

  // VACUUM rewrites the whole file and needs space equal to the database. On a store that is already
  // suspect that turns readable-but-damaged into a failed rewrite.
  test("never runs VACUUM", () => {
    expect(DatabaseHealth.REPAIRS.join(" ")).not.toContain("VACUUM")
  })
})

// ⚠️ The module above is tested against a plain bun:sqlite handle so a REAL corrupted file can be
// used. That leaves one thing unproven: that `executorOf` binds to the shape the live
// `Database.Service` actually has. This drives the real service, so a signature drift fails here
// rather than the first time someone opens a health screen.
describe("executorOf binds to the live Database service", () => {
  it.effect("reports ok against the instance's own store", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const report = yield* DatabaseHealth.check(DatabaseHealth.executorOf(db))
      expect(report.status).toBe("ok")
      // And healing a healthy store must stay a no-op through the real handle too.
      const healed = yield* DatabaseHealth.heal(DatabaseHealth.executorOf(db))
      expect(healed.attempted).toEqual([])
    }),
  )
})
