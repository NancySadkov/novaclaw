import { describe, expect, test } from "bun:test"
import nodeFs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { sql } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

/**
 * The DURABLE daily cold-start budget (AGENTS.md #9(b): starting a conversation needs explicit
 * permission **and its own stricter rate limit**) — the mechanism, at the store where it lives.
 *
 * `messenger-gateway.test.ts` owns the product-level proof (a second gateway over one database file
 * inherits the first one's spent slots). This file owns the four properties that proof rests on, each
 * of which is invisible from the gateway: what a "day" is, that the day only ever rolls FORWARD, that
 * test-and-charge is one statement, and that an unreadable counter fails typed rather than answering.
 *
 * ⚠️ Nothing here touches a wall clock. `chargeInitiation` takes the moment as an argument precisely
 * so a day boundary is a parameter rather than a wait — the gateway supplies `Clock.currentTimeMillis`
 * (so the TestClock can drive it) and these tests supply whatever instant they want to talk about.
 */

const graph = LayerNode.group([Database.node, MessengerStore.node])
const it = testEffect(AppNodeBuilder.build(graph))

/**
 * The same graph over a database FILE — a second store, on a second connection, sharing only bytes.
 *
 * ⚠️ **`Layer.fresh` is load-bearing.** Effect memoizes a layer by its INNER reference and
 * `Effect.provide` inherits the memo map already on the fiber (AGENTS.md pitfall -1), so a second
 * `Effect.provide(AppNodeBuilder.build(...))` inside a test returns the store that is ALREADY built —
 * database replacement and all. The durability test below would then be one store talking to itself
 * and would pass against a purely in-memory counter. `Layer.fresh` builds from a brand-new ROOT memo
 * map, which is the construction that genuinely yields a second instance; the test also asserts the
 * two services are different objects so this cannot rot back silently.
 */
const overFile = (file: string) =>
  Layer.fresh(AppNodeBuilder.build(graph, [[Database.node, Database.layerFromPath(file)]]))

/** Delete a test database and its WAL sidecars, BEST EFFORT — Windows holds the handle a moment past
 *  `close()`, so a prompt `rmSync` raises EBUSY and would fail a test whose assertions all passed. */
const discardDb = (file: string) => {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      nodeFs.rmSync(`${file}${suffix}`, { force: true })
    } catch {
      // best effort — see above
    }
  }
}

/** A cap small enough to exhaust in a line. The product's number lives in `MessengerGateway`. */
const CAP = 3

const DAY = 24 * 60 * 60_000
/** 2026-07-31T00:00:00Z, a fixed instant — never `Date.now()`, so the day these tests talk about is
 *  a property of the test and not of the afternoon it runs in. */
const NOON = Date.UTC(2026, 6, 31, 12)

const rows = Effect.gen(function* () {
  const { db } = yield* Database.Service
  return yield* db.all<{ scope: string; day: string; count: number }>(
    sql`SELECT scope, day, "count" AS count FROM messenger_initiation`,
  )
})

describe("MessengerStore.initiationDay", () => {
  test("a day is the UTC calendar date — not the machine's, and not the user's", () => {
    // Pinned by value. A local-time implementation would agree with this on some machines and
    // disagree on others, which is the whole reason the rule is UTC: the boundary must be a property
    // of the instant, so no timezone change, DST transition or travelling laptop can move it
    // underneath a counter that has already been charged.
    expect(MessengerStore.initiationDay(NOON)).toBe("2026-07-31")
    expect(MessengerStore.initiationDay(Date.UTC(2026, 6, 31, 23, 59, 59, 999))).toBe("2026-07-31")
    expect(MessengerStore.initiationDay(Date.UTC(2026, 7, 1, 0, 0, 0, 0))).toBe("2026-08-01")
    // The whole UTC day is one bucket, both edges included.
    expect(MessengerStore.initiationDay(Date.UTC(2026, 6, 31, 0))).toBe(MessengerStore.initiationDay(NOON))
  })

  test("ISO dates sort lexicographically the way they sort chronologically", () => {
    // Not a fact about dates in general — a fact `chargeInitiation` DEPENDS on, because its
    // roll-over-only-forward rule is a plain `>` between two strings inside SQL. A format change that
    // broke this (`31/07/2026`, say) would silently make every later day look like an earlier one.
    const days = [NOON - DAY, NOON, NOON + DAY, NOON + 400 * DAY].map(MessengerStore.initiationDay)
    expect([...days].sort()).toEqual(days)
    expect(days.every((day) => /^\d{4}-\d{2}-\d{2}$/.test(day))).toBe(true)
  })
})

describe("MessengerStore.chargeInitiation", () => {
  it.live("spends the day's slots one at a time and then says the day is gone", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      for (let spent = 1; spent <= CAP; spent++) {
        const charge = yield* store.chargeInitiation({ at: NOON, cap: CAP })
        expect(charge).toEqual({ kind: "charged", used: spent, day: "2026-07-31" })
      }
      // The cap is a ceiling on ATTEMPTS, so the refusal must not itself cost a slot — otherwise a
      // caller that retries would push the stored count arbitrarily far past the cap and the day
      // after would inherit nonsense.
      expect(yield* store.chargeInitiation({ at: NOON, cap: CAP })).toEqual({ kind: "exhausted" })
      expect(yield* store.chargeInitiation({ at: NOON, cap: CAP })).toEqual({ kind: "exhausted" })
      expect(yield* rows).toEqual([{ scope: "global", day: "2026-07-31", count: CAP }])
    }),
  )

  it.live("a cap of zero grants nothing — not even the day's first", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      // The hole this closes: `setWhere` filters the DO UPDATE arm, not the plain INSERT arm, so on
      // a virgin row (the day's first charge) the cap is not consulted by SQL at all. Without the
      // guard in `chargeInitiation` a zero cap would still hand out one cold start every day — and
      // "set it to 0 to stop initiating" is the obvious next feature to want.
      expect(yield* store.chargeInitiation({ at: NOON, cap: 0 })).toEqual({ kind: "exhausted" })
      // …and it did not even create the row, so a later real cap starts from a clean day.
      expect(yield* rows).toEqual([])
      expect((yield* store.chargeInitiation({ at: NOON, cap: CAP })).kind).toBe("charged")
    }),
  )

  it.live("the budget is GLOBAL — one row, whatever else the instance is doing", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      // Principle 9(a)'s "one hand": the outbound governor is global across every chat and account
      // because what a provider — and a person — sees is one operator's behaviour. Keying this per
      // account would multiply the shipped cap by however many messengers are configured, which is a
      // LOOSER policy smuggled in as a durability fix. One row, by construction.
      yield* store.chargeInitiation({ at: NOON, cap: CAP })
      yield* store.chargeInitiation({ at: NOON + 60_000, cap: CAP })
      const all = yield* rows
      expect(all).toHaveLength(1)
      expect(all[0]?.scope).toBe(MessengerStore.INITIATION_SCOPE)
    }),
  )

  it.live("a new UTC day is a fresh budget", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      for (let spent = 0; spent < CAP; spent++) yield* store.chargeInitiation({ at: NOON, cap: CAP })
      expect(yield* store.chargeInitiation({ at: NOON, cap: CAP })).toEqual({ kind: "exhausted" })
      const tomorrow = yield* store.chargeInitiation({ at: NOON + DAY, cap: CAP })
      expect(tomorrow).toEqual({ kind: "charged", used: 1, day: "2026-08-01" })
      // …and the old day is gone rather than kept alongside: one row, rolled over in place.
      expect(yield* rows).toEqual([{ scope: "global", day: "2026-08-01", count: 1 }])
    }),
  )

  it.live("a clock that jumps BACKWARDS does not mint a second budget for one real day", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      // The reason the roll-over test is `today > day` and not `today !== day`. An NTP correction, a
      // user fixing the date, or a VM resuming from a snapshot all look exactly like a new day to an
      // inequality — and would hand out a whole second twenty for the same afternoon.
      for (let spent = 0; spent < CAP; spent++) yield* store.chargeInitiation({ at: NOON + DAY, cap: CAP })
      expect(yield* store.chargeInitiation({ at: NOON, cap: CAP })).toEqual({ kind: "exhausted" })
      expect(yield* store.chargeInitiation({ at: NOON - 30 * DAY, cap: CAP })).toEqual({ kind: "exhausted" })
      // The stored day did not move backwards either — a later charge on the real day must still find
      // the bucket it left behind.
      expect(yield* rows).toEqual([{ scope: "global", day: "2026-08-01", count: CAP }])
    }),
  )

  it.live("an unreadable counter FAILS — it never answers `charged` and never answers `exhausted`", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const { db } = yield* Database.Service
      yield* db.run("DROP TABLE messenger_initiation")

      const outcome = yield* store.chargeInitiation({ at: NOON, cap: CAP }).pipe(
        Effect.map((charge) => ({ answered: true as const, charge })),
        Effect.catch((error) => Effect.succeed({ answered: false as const, error })),
      )
      // Neither invented answer: `charged` would be an uncounted cold DM, `exhausted` a statement
      // about the day's traffic made from a write that never happened.
      expect(outcome.answered).toBe(false)
      if (!outcome.answered) {
        // A typed failure, not a die: `orDie` unwinds the caller's fiber and makes every recovery
        // written against it unreachable code — the defect class this module already fixed three
        // times over (see `UnavailableError`).
        expect(outcome.error._tag).toBe("MessengerStore.Unavailable")
        expect(outcome.error.read).toContain("chargeInitiation")
      }

      // …and through the consumer-facing adapter it is an explicit "this read did not happen",
      // which is what `gateway.send` branches on to answer `unavailable` rather than sending.
      const attempt = yield* MessengerStore.attempted(store.chargeInitiation({ at: NOON, cap: CAP }))
      expect(attempt.read).toBe(false)
      expect(attempt.value).toBeUndefined()
    }),
  )

  it.live("the budget survives the store that spent it — a second store over one file resumes it", () =>
    Effect.gen(function* () {
      const file = nodePath.join(os.tmpdir(), `novaclaw-initiation-${process.pid}.db`)
      // Store #1 spends the day.
      const first = yield* Effect.gen(function* () {
        const store = yield* MessengerStore.Service
        for (let spent = 0; spent < CAP; spent++)
          expect((yield* store.chargeInitiation({ at: NOON, cap: CAP })).kind).toBe("charged")
        return store
      }).pipe(Effect.scoped, Effect.provide(overFile(file)))

      // Store #2 shares nothing with it but the file — and inherits an exhausted day.
      yield* Effect.gen(function* () {
        const store = yield* MessengerStore.Service
        // The guard that keeps this from being one store talking to itself — see `overFile`.
        expect(store).not.toBe(first)
        expect(yield* store.chargeInitiation({ at: NOON, cap: CAP })).toEqual({ kind: "exhausted" })
        // …and tomorrow is still tomorrow: durability must not also freeze the counter.
        expect((yield* store.chargeInitiation({ at: NOON + DAY, cap: CAP })).kind).toBe("charged")
      }).pipe(Effect.scoped, Effect.provide(overFile(file)))
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => discardDb(nodePath.join(os.tmpdir(), `novaclaw-initiation-${process.pid}.db`))),
      ),
    ),
  )

  it.live("concurrent charges never oversell the day", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const results = yield* Effect.all(
        Array.from({ length: CAP * 4 }, () => store.chargeInitiation({ at: NOON, cap: CAP })),
        { concurrency: "unbounded" },
      )
      expect(results.filter((result) => result.kind === "charged")).toHaveLength(CAP)
      // Every granted slot is a distinct number: two callers must never be told they are both the
      // third of the day.
      const used = results.flatMap((result) => (result.kind === "charged" ? [result.used] : []))
      expect([...used].sort((a, b) => a - b)).toEqual(Array.from({ length: CAP }, (_, index) => index + 1))
    }),
  )
})

// ───────────────────────────────────────────────────────────────────────────────────────────────
// THE ATOMICITY RATCHET.
//
// ⚠️ **The test above cannot prove what it looks like it proves, and saying so is the point.** The
// SQLite driver here is SYNCHRONOUS on a single-threaded runtime, so no two statements interleave no
// matter how many fibers ask at once — a read-then-write implementation would pass the concurrency
// test on this machine and still be wrong on a machine (or a future driver) where the write can
// suspend. The durable counter is what INTRODUCED that window: the in-memory bucket it replaces
// tested and incremented in one synchronous tick, so `if (count >= cap) …; count += 1` was safe there
// and is not safe here.
//
// So the real guarantee is STRUCTURAL — the check, the day rollover and the increment are one SQL
// statement — and a structural guarantee gets a structural check (todo.md ruling 1). Splitting it
// into a `select` then an `insert` would read as a tidy-up and would compile green.
// ───────────────────────────────────────────────────────────────────────────────────────────────

const STORE_SOURCE = nodeFs.readFileSync(nodePath.join(import.meta.dir, "../src/messenger/store.ts"), "utf8")

/** The body of one `Effect.fn("MessengerStore.<name>")` implementation, up to the next one. */
const implementation = (name: string): string => {
  const start = STORE_SOURCE.indexOf(`Effect.fn("MessengerStore.${name}")`)
  if (start < 0) return ""
  const next = STORE_SOURCE.indexOf(`Effect.fn("MessengerStore.`, start + 1)
  return STORE_SOURCE.slice(start, next < 0 ? undefined : next)
}

/** Every `db.<verb>(` the implementation issues. One means one statement. */
const statements = (source: string): string[] =>
  [...source.matchAll(/\bdb\s*\.\s*(select|insert|update|delete|run|all|get)\b/g)].map((match) => match[1]!)

describe("charging the daily budget is ONE statement", () => {
  const body = implementation("chargeInitiation")

  test("the scan can see the store source at all", () => {
    // Without this a rename empties the slice and every assertion below passes forever on "".
    expect(body).toContain("MessengerInitiationTable")
    expect(implementation("chargeInitiation")).not.toBe("")
  })

  test("it issues exactly one database statement — no read-then-write window", () => {
    expect(statements(body)).toEqual(["insert"])
  })

  test("the cap is tested INSIDE that statement, and the day rolls over only forward", () => {
    // `setWhere` is the cap test: SQLite skips a `DO UPDATE` whose `WHERE` is false and returns no
    // row, which is how `exhausted` is established by the same statement that would have charged.
    expect(body).toContain("setWhere:")
    expect(body).toContain(`${"$"}{count} < ${"$"}{input.cap}`)
    // `>` and never `!==`: an inequality would treat a backwards clock jump as a new day.
    expect(body).toContain(`CASE WHEN ${"$"}{today} > ${"$"}{day} THEN 1 ELSE ${"$"}{count} + 1 END`)
  })

  test("it never reads the clock for itself", () => {
    // The day must be a function of the caller's instant, or the gateway's TestClock discipline is a
    // fiction and the boundary becomes untestable without waiting for real midnight.
    expect(body).not.toContain("Date.now()")
    expect(body).toContain("initiationDay(input.at)")
  })
})

describe("the atomicity ratchet actually bites (negative control)", () => {
  test("a read-then-write rewrite is what the statement scan reports", () => {
    const rogue = `Effect.fn("MessengerStore.chargeInitiation")(function* (input) {
        const row = yield* db.select().from(MessengerInitiationTable).get()
        if ((row?.count ?? 0) >= input.cap) return { kind: "exhausted" }
        yield* db.insert(MessengerInitiationTable).values({ count: (row?.count ?? 0) + 1 }).run()
      })`
    expect(statements(rogue)).toEqual(["select", "insert"])
    expect(statements(rogue)).not.toEqual(["insert"])
  })

  test("a wall-clock read inside the charge is what the clock check reports", () => {
    const rogue = `const today = initiationDay(${"Date.now" + "()"})`
    expect(rogue).toContain("Date.now()")
    expect(rogue).not.toContain("initiationDay(input.at)")
  })
})
