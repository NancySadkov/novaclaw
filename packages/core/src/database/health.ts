export * as DatabaseHealth from "./health"

import { Effect } from "effect"
import { sql } from "drizzle-orm"

/**
 * Is the store readable, and can a routine repair make it so?
 *
 * Owner, 2026-08-11: *"Database health — please ensure it is implemented, as well as healing."*
 * `notes/reports/nova-health-inputs-2026-08-11.md` had this as one of two Nova Health signals with
 * no probe at all.
 *
 * ## Why `quick_check` and not `integrity_check`
 *
 * A standing decision already settled this before it was written: `never-breaks` A1 proposed
 * `PRAGMA integrity_check` on every boot, and *startup speed is first-class* won — `integrity_check`
 * is O(database size) and no ruling costs it. `quick_check` does the same page-level work while
 * skipping the exhaustive index cross-check, so it is the boot-safe probe; the full check belongs on
 * the FAILURE path, after this one says something is wrong.
 *
 * ## What "healing" may mean, and what it may not
 *
 * Every repair here is non-destructive and reversible in the sense that matters: none of them can
 * lose a row that SQLite could still read. That is a deliberate ceiling. A corrupt page is not
 * something a maintenance pragma fixes, and the honest response to one is to say so — a "repair"
 * that reported success over a store the engine still cannot read would be ruling 2 on the surface a
 * person reaches for when they already suspect their data is damaged.
 *
 * So `heal` re-checks afterwards and reports the check's verdict, never its own optimism.
 */

/** The minimum this module needs — kept tiny so a test can drive it against a real file. */
export interface Executor {
  readonly run: (sql: string) => Effect.Effect<unknown, unknown>
  readonly rows: (sql: string) => Effect.Effect<ReadonlyArray<Record<string, unknown>>, unknown>
}

export type Status = "ok" | "damaged" | "unknown"

export interface Report {
  readonly status: Status
  /** SQLite's own words when it is not `ok`, or the reason the probe could not run. */
  readonly detail?: string
}

/**
 * `PRAGMA quick_check` — `ok` when SQLite says `ok`, `damaged` when it says anything else.
 *
 * ⚠️ A probe that THREW is `unknown`, never `damaged`. The two are different facts: a locked file, a
 * closed handle or a driver fault says nothing about the pages, and reporting "your database is
 * damaged" because we could not ask is a false description of someone's data.
 */
export const check = (executor: Executor): Effect.Effect<Report> =>
  executor.rows("PRAGMA quick_check").pipe(
    Effect.map((rows): Report => {
      // SQLite returns one row, one column, the string "ok" — but the column NAME differs by driver,
      // so read the first value rather than a key we would have to guess.
      const first = rows[0] === undefined ? undefined : Object.values(rows[0])[0]
      const answer = typeof first === "string" ? first : undefined
      if (answer === undefined) return { status: "unknown", detail: "quick_check returned no rows" }
      if (answer.toLowerCase() === "ok") return { status: "ok" }
      return { status: "damaged", detail: answer }
    }),
    Effect.catchCause((cause) =>
      Effect.succeed({ status: "unknown" as const, detail: `quick_check could not run: ${String(cause).slice(0, 200)}` }),
    ),
  )

/**
 * The repairs, in the order a maintenance pass should try them.
 *
 * Ordered cheapest-first and each safe on its own: a checkpoint folds the WAL back into the main
 * file, `optimize` is what SQLite itself recommends running periodically, and `REINDEX` rebuilds
 * indexes from the tables they index — which is the one class of damage a routine pass genuinely
 * repairs.
 *
 * ⚠️ `VACUUM` is deliberately ABSENT. It rewrites the whole file, needs free space of roughly the
 * database's own size, and on a store that is already suspect it turns a readable-but-damaged file
 * into a failed rewrite. Reclaiming space is not healing, and this list is not the place to do it.
 */
export const REPAIRS: readonly string[] = ["PRAGMA wal_checkpoint(TRUNCATE)", "PRAGMA optimize", "REINDEX"]

export interface Healed {
  /** The verdict AFTER the repairs — the check's answer, never this function's optimism. */
  readonly status: Status
  readonly detail?: string
  /** What actually ran. A repair that threw is named here too, with its fault. */
  readonly attempted: ReadonlyArray<{ readonly sql: string; readonly ok: boolean; readonly error?: string }>
  /** True only when the store was damaged BEFORE and is `ok` after. */
  readonly repaired: boolean
}

/**
 * Try the routine repairs, then re-check.
 *
 * Runs them even when the first check says `unknown`: not being able to ask is itself a reason a
 * checkpoint might help (a stale WAL, a handle mid-recovery). It does NOT run them when the store is
 * already `ok` — a healthy database does not need a maintenance pass every time someone opens a
 * health screen, and `REINDEX` on a large store is not free.
 */
export const heal = (executor: Executor): Effect.Effect<Healed> =>
  Effect.gen(function* () {
    const before = yield* check(executor)
    if (before.status === "ok") return { status: "ok" as const, attempted: [], repaired: false }
    const attempted: { sql: string; ok: boolean; error?: string }[] = []
    for (const sql of REPAIRS) {
      const failure = yield* executor.run(sql).pipe(
        Effect.as(undefined),
        Effect.catchCause((cause) => Effect.succeed(String(cause).slice(0, 200))),
      )
      attempted.push(failure === undefined ? { sql, ok: true } : { sql, ok: false, error: failure })
    }
    const after = yield* check(executor)
    return {
      status: after.status,
      ...(after.detail === undefined ? {} : { detail: after.detail }),
      attempted,
      // Only a `damaged` → `ok` transition counts. `unknown` → `ok` means the probe started working,
      // which is worth reporting as healthy but is not evidence that a repair fixed anything.
      repaired: before.status === "damaged" && after.status === "ok",
    }
  })

/**
 * Bind the probe to the real `Database.Service` handle.
 *
 * Kept as an adapter rather than typing `Executor` against the live shape, so the checks above stay
 * runnable against a plain `bun:sqlite` file — which is the only way to test them against a genuinely
 * CORRUPTED database, and a corruption test is what makes the healthy answer mean anything.
 */
export const executorOf = (db: {
  readonly run: (query: string) => Effect.Effect<unknown, unknown>
  readonly all: <T>(query: ReturnType<typeof sql>) => Effect.Effect<ReadonlyArray<T>, unknown>
}): Executor => ({
  run: (statement) => db.run(statement),
  // `sql.raw`: these are fixed pragma strings from `REPAIRS` and this module, never caller input.
  rows: (statement) => db.all<Record<string, unknown>>(sql.raw(statement)),
})
