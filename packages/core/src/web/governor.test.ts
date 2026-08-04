// The governor's effectful half against a real (in-memory) DB. The headline assertion is DURABILITY: a
// fresh governor over the same database still sees the day's spend, because "restart to reset the cap" is
// exactly the runaway this guards against.
import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Duration, Effect } from "effect"
import type { Database } from "../database/database"
import { DatabaseMigration } from "../database/migration"
import { WebGovernor } from "./governor"

const makeDb = EffectDrizzleSqlite.makeWithDefaults()
// `guard` can fail with WebBudgetError, so the body's error channel must be allowed through — a plain
// `Effect<A>` signature typechecks only until a test calls guard without folding the failure.
const withDb = <A, E>(fn: (db: Database.Interface["db"]) => Effect.Effect<A, E>): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* makeDb
      yield* DatabaseMigration.apply(db)
      return yield* fn(db)
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const T0 = Date.UTC(2026, 6, 25, 12, 0, 0)

/** A governor with a frozen clock, no real sleeping, and recorded waits. */
const governor = (db: Database.Interface["db"], limits: WebGovernor.ResolvedLimits, clock = { now: T0 }) => {
  const waits: number[] = []
  const service = WebGovernor.make({
    db,
    limits: () => Effect.succeed(limits),
    now: () => Effect.sync(() => clock.now),
    sleep: (ms) =>
      Effect.sync(() => {
        waits.push(ms)
        clock.now += ms // a real sleep advances time; the fake must too or pacing never settles
      }),
    random: () => 0.5, // mid-jitter → deterministic
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

describe("WebGovernor.readLimits", () => {
  test("maps the settings block, and ignores a missing/garbage one", () => {
    expect(WebGovernor.readLimits(undefined)).toEqual({})
    expect(WebGovernor.readLimits({})).toEqual({})
    expect(WebGovernor.readLimits({ throttle: { hostIntervalMs: 1000, dailyPerHost: 9, bogus: "x" } })).toEqual({
      intervalMs: 1000,
      dailyLimit: 9,
    })
  })

  test("keeps a 0 so the policy can treat it as 'use default' rather than losing the distinction", () => {
    expect(WebGovernor.readLimits({ throttle: { dailyPerHost: 0 } })).toEqual({ dailyLimit: 0 })
  })
})

describe("WebGovernor.guard", () => {
  test("passes the fetch through and paces subsequent reads of the same host", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 4000, burst: 2, dailyLimit: 50 })
        const results: string[] = []
        for (let i = 0; i < 4; i++)
          results.push(yield* g.service.guard({ url: `https://example.com/a${i}`, fetch: ok }))
        return { results, waits: g.waits }
      }),
    )
    expect(out.results).toEqual(["fetched", "fetched", "fetched", "fetched"])
    // burst of 2 is free; the rest are paced
    expect(out.waits.filter((w) => w > 0)).toHaveLength(2)
  })

  test("DURABLE: a fresh governor over the same DB still sees today's spend", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const limits = { intervalMs: 1, burst: 10, dailyLimit: 3 }
        // First "process" spends the whole daily budget.
        const first = governor(db, limits)
        for (let i = 0; i < 3; i++) yield* first.service.guard({ url: `https://example.com/${i}`, fetch: ok })
        // A brand-new governor — i.e. a restart. It must NOT get a fresh allowance.
        const second = governor(db, limits)
        return yield* second.service.guard({ url: "https://example.com/after-restart", fetch: ok }).pipe(attempt)
      }),
    )
    expect(out.ok).toBe(false)
    expect(out.message).toContain("Daily read limit reached")
  })

  test("the daily cap is PER HOST — one site's spend doesn't starve another", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 1 })
        yield* g.service.guard({ url: "https://a.example/x", fetch: ok })
        const otherHost = yield* g.service.guard({ url: "https://b.example/x", fetch: ok }).pipe(attempt)
        const sameHost = yield* g.service.guard({ url: "https://a.example/y", fetch: ok }).pipe(attempt)
        return { otherHost: otherHost.ok, sameHost: sameHost.ok }
      }),
    )
    expect(out.otherHost).toBe(true) // a different site is unaffected
    expect(out.sameHost).toBe(false) // the spent one is capped
  })

  test("refuses a fetch LOOP on the same URL, and does not spend budget on it", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 50, sameUrlLimit: 3 })
        const url = "https://example.com/stuck"
        const seen: boolean[] = []
        for (let i = 0; i < 5; i++) {
          const r = yield* g.service.guard({ url, sessionID: "ses_1", fetch: ok }).pipe(attempt)
          seen.push(r.ok)
        }
        return seen
      }),
    )
    // first 3 go through, then the guard trips and keeps tripping
    expect(out).toEqual([true, true, true, false, false])
  })

  test("the loop counter is per SESSION — a new session may read the same page", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 50, sameUrlLimit: 2 })
        const url = "https://example.com/p"
        yield* g.service.guard({ url, sessionID: "ses_a", fetch: ok })
        yield* g.service.guard({ url, sessionID: "ses_a", fetch: ok })
        const blocked = yield* g.service.guard({ url, sessionID: "ses_a", fetch: ok }).pipe(attempt)
        const other = yield* g.service.guard({ url, sessionID: "ses_b", fetch: ok }).pipe(attempt)
        return { blocked: blocked.ok, other: other.ok }
      }),
    )
    expect(out.blocked).toBe(false)
    expect(out.other).toBe(true)
  })

  test("a non-HTTP/garbage URL is passed straight through — malformed input is the fetch's error to report", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, {})
        return yield* g.service.guard({ url: "not a url", fetch: ok })
      }),
    )
    expect(out).toBe("fetched")
  })

  // Both web surfaces ride this guard, and only the CALLER knows what the model actually asked for:
  // `webfetch` was handed a URL, `websearch` was handed a query and has no idea the engine endpoint
  // exists. So the loop refusal is overridable per surface — while everything else about the refusal
  // (when it fires, that it costs no budget) stays one implementation.
  test("the loop refusal can be worded by the SURFACE, and falls back to the URL when it isn't", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 50, sameUrlLimit: 1 })
        const engine = "https://html.duckduckgo.com/html/?q=bun"
        const searched = (count: number) => `searched "bun" ${count} times already`
        yield* g.service.guard({ url: engine, sessionID: "ses_1", loopReason: searched, fetch: ok })
        const named = yield* g.service
          .guard({ url: engine, sessionID: "ses_1", loopReason: searched, fetch: ok })
          .pipe(attempt)
        yield* g.service.guard({ url: "https://example.com/page", sessionID: "ses_1", fetch: ok })
        const defaulted = yield* g.service
          .guard({ url: "https://example.com/page", sessionID: "ses_1", fetch: ok })
          .pipe(attempt)
        return { named, defaulted }
      }),
    )
    expect(out.named.ok).toBe(false)
    expect(out.named.message).toBe(`searched "bun" 1 times already`)
    expect(out.named.message).not.toContain("duckduckgo.com") // the endpoint stays out of the model's face
    expect(out.defaulted.ok).toBe(false)
    expect(out.defaulted.message).toContain("https://example.com/page")
  })

  // The rule most likely to be WRONG for a metasearch fan-out — so measure it rather than assume it.
  // A fan-out issues one request per ENGINE, i.e. one per host, so per-host semaphores must all be
  // enterable at once; what has to serialize is two readers of the SAME site.
  test("one-in-flight is PER HOST: different hosts overlap, the same host queues", async () => {
    const trace: string[] = []
    const busy = (tag: string) =>
      Effect.gen(function* () {
        trace.push(`${tag}:in`)
        yield* Effect.sleep(Duration.millis(20))
        trace.push(`${tag}:out`)
        return tag
      })
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const g = governor(db, { intervalMs: 1, burst: 10, dailyLimit: 50 })
        yield* Effect.all(
          [
            g.service.guard({ url: "https://a.example/x", fetch: busy("a") }),
            g.service.guard({ url: "https://b.example/x", fetch: busy("b") }),
          ],
          { concurrency: "unbounded" },
        )
        const crossHost = [...trace]
        trace.length = 0
        yield* Effect.all(
          [
            g.service.guard({ url: "https://c.example/1", fetch: busy("c1") }),
            g.service.guard({ url: "https://c.example/2", fetch: busy("c2") }),
          ],
          { concurrency: "unbounded" },
        )
        return { crossHost, sameHost: [...trace] }
      }),
    )
    // Phases only, so the assertion is about OVERLAP rather than which fiber happened to win a race.
    const phases = (entries: readonly string[]) => entries.map((entry) => entry.split(":")[1])
    // Two hosts are both in flight before either finishes — the fan-out is not serialized.
    expect(phases(out.crossHost)).toEqual(["in", "in", "out", "out"])
    expect(out.crossHost.slice(0, 2).sort()).toEqual(["a:in", "b:in"])
    // One host is read by one connection at a time — no swarming a site with parallel streams.
    expect(phases(out.sameHost)).toEqual(["in", "out", "in", "out"])
    expect(new Set(out.sameHost).size).toBe(4)
  })

  test("a new UTC day restores the allowance", async () => {
    const out = await withDb((db) =>
      Effect.gen(function* () {
        const limits = { intervalMs: 1, burst: 10, dailyLimit: 2 }
        const clock = { now: T0 }
        const g = governor(db, limits, clock)
        yield* g.service.guard({ url: "https://example.com/1", fetch: ok })
        yield* g.service.guard({ url: "https://example.com/2", fetch: ok })
        const capped = yield* g.service.guard({ url: "https://example.com/3", fetch: ok }).pipe(attempt)
        clock.now = T0 + 24 * 3_600_000
        const tomorrow = yield* g.service.guard({ url: "https://example.com/4", fetch: ok }).pipe(attempt)
        return { capped: capped.ok, tomorrow: tomorrow.ok }
      }),
    )
    expect(out.capped).toBe(false)
    expect(out.tomorrow).toBe(true)
  })
})
