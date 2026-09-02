// The web governor's per-host budget UNDER CONCURRENCY — the property the sequential suite in
// `src/web/governor.test.ts` cannot see.
//
// The budget is a read-modify-write over one SQLite row: select the host's counters, run the pure
// policy, write the result back. Every existing test drives it one call at a time, so every existing
// test passes whether or not those three steps are serialized — and they were not. Two fibers entering
// for one host both read the same row before either wrote, both computed the same `count + 1` and the
// same fire instant, and the second `onConflictDoUpdate` overwrote the first with an identical value:
// N parallel reads charged the daily counter ONCE, spent ONE token, and woke from one jittered wait
// together. The cap the Traffic-limits panel promises was silently divided by the fan-out, on the one
// module whose entire job is not to swarm a site.
//
// ⚠️ Every test here DRIVES the interleaving rather than hoping for it: the injected clock SUSPENDS
// before it answers, and `charge` reads the clock between the row read and the row write, so a fiber
// parks in the middle of the accounting section every single time. An unserialized implementation is
// then guaranteed to interleave rather than merely likely to — a final total both interleavings happen
// to produce would prove nothing. Measured with the permit removed: three of the four below fail, while
// all eleven sequential tests in `src/web/governor.test.ts` stay green, which is why the property needed
// a file of its own.
//
// ⚠️ **A measured caveat, recorded so nobody mistakes the current calm for a guarantee.** Both SQLite
// legs (`database/sqlite.bun.ts`, `sqlite.node.ts`) run statements synchronously and effect resolves an
// uncontended permit without yielding, so today a real `select`+`insert` pair does not suspend and the
// interleave is not reachable through the driver — probed on 2026-09-02, including with another fiber
// holding a transaction. That is an accident of the driver, not a property `Deps.db` states or this
// module controls: one async statement, one added span, one awaited read moved inside the section, and
// the counter is silently divided by the fan-out. The permit is what makes the atomicity a
// PROPERTY of this file rather than a coincidence of the layer below it, and the suspending clock here
// is how that is demonstrated rather than asserted.
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Duration, Effect } from "effect"
import { eq } from "drizzle-orm"
import type { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { WebGovernor } from "@novaclaw/core/web/governor"
import { WebHostBudgetTable } from "@novaclaw/core/web/budget.sql"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

const withDb = <A, E>(fn: (db: Database.Interface["db"]) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      return yield* fn(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const T0 = Date.UTC(2026, 6, 25, 12, 0, 0)

/**
 * A governor whose clock SUSPENDS before answering. That single detail is what makes these tests real:
 * `charge` reads the clock BETWEEN the row read and the row write, so every fiber inside the accounting
 * section parks in the middle of it. Serialized, that is harmless — the suspension happens while the
 * host's permit is held. Unserialized, it is the race, deterministically.
 */
const governor = (db: Database.Interface["db"], limits: WebGovernor.ResolvedLimits, clock = { now: T0 }) => {
  const waits: number[] = []
  const service = WebGovernor.make({
    db,
    limits: () => Effect.succeed(limits),
    now: () =>
      Effect.gen(function* () {
        yield* Effect.sleep(Duration.millis(1))
        return clock.now
      }),
    sleep: (ms) =>
      Effect.sync(() => {
        waits.push(ms)
        clock.now += ms // a real sleep advances time; the fake must too or pacing never settles
      }),
    random: () => 0.5, // mid-jitter → the wait is passed through unchanged
  })
  return { service, waits, clock }
}

const ok = Effect.succeed("fetched")

/** `Effect.either` doesn't exist in this effect build — fold to a plain tagged result instead. */
const attempt = <A, E>(eff: Effect.Effect<A, E>): Effect.Effect<{ ok: boolean; message: string }> =>
  eff.pipe(
    Effect.map(() => ({ ok: true, message: "" })),
    Effect.catch((error: E) => Effect.succeed({ ok: false, message: String((error as Error)?.message ?? error) })),
  )

const spent = (db: Database.Interface["db"], host: string) =>
  db
    .select()
    .from(WebHostBudgetTable)
    .where(eq(WebHostBudgetTable.host, host))
    .get()
    .pipe(
      Effect.orDie,
      Effect.map((row) => row?.count ?? 0),
    )

describe("WebGovernor.guard under concurrency", () => {
  test("N parallel reads of ONE host cannot exceed the daily cap", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 2 })
        // Distinct paths, one host: the loop guard is per URL, so this is a budget test and not a
        // loop test wearing its clothes.
        const results = yield* Effect.all(
          Array.from({ length: 6 }, (_, i) =>
            g.service.guard({ url: `https://swarm.test/${i}`, fetch: ok }).pipe(attempt),
          ),
          { concurrency: "unbounded" },
        )
        return { allowed: results.filter((r) => r.ok).length, charged: yield* spent(db, "swarm.test") }
      }),
    )
    // What actually got through, not what the last writer happened to record.
    expect(out.allowed).toBe(2)
    expect(out.charged).toBe(2)
  })

  test("CONTROL: the same six reads issued SEQUENTIALLY behave identically", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 2 })
        const results: boolean[] = []
        for (let i = 0; i < 6; i++)
          results.push((yield* g.service.guard({ url: `https://swarm.test/${i}`, fetch: ok }).pipe(attempt)).ok)
        return { allowed: results.filter(Boolean).length, charged: yield* spent(db, "swarm.test") }
      }),
    )
    expect(out.allowed).toBe(2)
    expect(out.charged).toBe(2)
  })

  test("CONTROL: a second host's budget is untouched by the first host's swarm", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 2 })
        const results = yield* Effect.all(
          [
            ...Array.from({ length: 5 }, (_, i) => g.service.guard({ url: `https://a.test/${i}`, fetch: ok })),
            ...Array.from({ length: 5 }, (_, i) => g.service.guard({ url: `https://b.test/${i}`, fetch: ok })),
          ].map(attempt),
          { concurrency: "unbounded" },
        )
        return {
          allowed: results.filter((r) => r.ok).length,
          a: yield* spent(db, "a.test"),
          b: yield* spent(db, "b.test"),
        }
      }),
    )
    // Two hosts, two independent caps — the fan-out ACROSS hosts is what search needs and keeps.
    expect(out.a).toBe(2)
    expect(out.b).toBe(2)
    expect(out.allowed).toBe(4)
  })

  test("parallel reads of one host are PACED apart, not released as one burst", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        // burst 1: the first read is free, every later one must wait for a token to accrue.
        const g = governor(db, { intervalMs: 1000, burst: 1, dailyLimit: 50 })
        yield* Effect.all(
          Array.from({ length: 3 }, (_, i) => g.service.guard({ url: `https://paced.test/${i}`, fetch: ok })),
          { concurrency: "unbounded" },
        )
        return { waits: g.waits, charged: yield* spent(db, "paced.test") }
      }),
    )
    // Three reads, three charges — not one charge shared by three fibers that all read the empty row.
    expect(out.charged).toBe(3)
    // One free burst token, so exactly two of the three had to wait, and neither waited zero.
    expect(out.waits).toHaveLength(2)
    expect(out.waits.every((wait) => wait > 0)).toBe(true)
  })
})
