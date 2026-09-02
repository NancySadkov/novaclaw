export * as WebGovernor from "./governor"

// The web traffic governor's effectful half — the thing `webfetch` actually calls. `fetch-pace.ts` holds
// the pure decision; this owns the three pieces that need a runtime:
//
//   1. **Durable per-host budget** (SQLite). The daily cap has to outlive the process, or a crash-looping
//      agent resets its own counter on every restart and hammers a host all day — exactly the failure the
//      cap exists to stop.
//   2. **Per-host concurrency** (in-memory semaphores). "Don't swarm one site with parallel streams" is a
//      property of what is in flight RIGHT NOW, so it is process-local by nature.
//   3. **Same-URL loop detection** (in-memory, per session). A stuck agent re-fetching one page is a
//      runaway; refuse it with a reason that points at a different source instead of grinding.
//
// Limits come from the LIVE config (`web_search.throttle`) on every call, so a settings change takes
// effect without a restart — and `0` there means "use the default" (see fetch-pace `positive`).
//
// ⚠️ **BOTH web surfaces ride this, and that is the point.** `tool/webfetch.ts` reads a page; the
// `websearch` engines (`websearch/service.ts`) read a search endpoint. They are one machine's outbound
// web traffic to a site, so they share one per-host budget and one queue — a search of
// `en.wikipedia.org` and a fetch of an article there are the same server being read by the same person.
// The only thing that differs per surface is the WORDING of a loop refusal (`loopReason` below), because
// only the caller knows what the model actually asked for.

import { Effect, Layer, Context, Duration, Semaphore } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SettingsConfigStore } from "../settings-config-store"
import { WebFetchPace } from "./fetch-pace"
import { WebHostBudgetTable } from "./budget.sql"

/** Refused because a cap or the loop guard tripped — NOT a network failure; the message is model-facing. */
export class WebBudgetError extends Error {
  readonly _tag = "WebBudgetError"
}

export interface Interface {
  /**
   * Gate one outbound read. Waits the paced delay, then returns; fails with `WebBudgetError` when the
   * daily cap or the loop guard refuses. Runs the fetch INSIDE the per-host concurrency slot.
   */
  readonly guard: <A, E, R>(input: {
    readonly url: string
    readonly sessionID?: string
    /**
     * How the loop refusal names this read. Defaults to the URL, which is right for `webfetch` — the
     * model chose that URL, so it recognises it. `websearch` overrides it with the QUERY, because the
     * engine endpoint (`html.duckduckgo.com/html/?q=…`) is an internal detail the model never asked for,
     * and telling a looping agent about it invites it to `webfetch` that URL instead of rewording. Same
     * refusal, same guard — only the sentence differs, and only the caller can write it honestly.
     */
    readonly loopReason?: (seenCount: number) => string
    readonly fetch: Effect.Effect<A, E, R>
  }) => Effect.Effect<A, E | WebBudgetError, R>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/WebGovernor") {}

interface Deps {
  readonly db: Database.Interface["db"]
  readonly limits: () => Effect.Effect<WebFetchPace.Limits & { perHostConcurrency?: number; sameUrlLimit?: number }>
  readonly now: () => Effect.Effect<number>
  readonly sleep: (ms: number) => Effect.Effect<void>
  readonly random: () => number
}

/**
 * One host's runtime state. Two semaphores, because they guard two different things and holding one
 * for the other's duration would be wrong in both directions:
 *
 *   · `budget` serializes the ACCOUNTING (read the row, decide, write it back). Held for microseconds,
 *     released before any wait.
 *   · `inflight` serializes the FETCH — the "no parallel streams at one site" rule. Held for the whole
 *     network read, and its width is the configured `perHostConcurrency`.
 */
interface HostLane {
  readonly budget: Semaphore.Semaphore
  readonly inflight: Semaphore.Semaphore
}

export const make = (deps: Deps): Interface => {
  const lanes = new Map<string, HostLane>()
  // sessionID+url -> times fetched. Process-local: a loop happens within a run.
  const seen = new Map<string, number>()

  /**
   * ⚠️ **Synchronous on purpose.** The obvious version reads the map, `yield*`s a `Semaphore.make`, then
   * writes the map — a check-then-act with a suspension point inside it, which is the same defect this
   * lane exists to close: two fibers racing on a host's FIRST read each build their own lane, the second
   * overwrites the first in the map, and the two fibers then hold DIFFERENT semaphores, so neither the
   * budget lock nor the in-flight limit binds them. `Semaphore.makeUnsafe` keeps get-and-set in one tick,
   * where no other fiber can run.
   */
  const laneFor = (host: string, permits: number): HostLane => {
    const existing = lanes.get(host)
    if (existing) return existing
    const created: HostLane = {
      budget: Semaphore.makeUnsafe(1),
      inflight: Semaphore.makeUnsafe(Math.max(1, permits)),
    }
    lanes.set(host, created)
    return created
  }

  /**
   * Charge one read against the durable per-host row — **the only reader or writer of
   * `WebHostBudgetTable` in this module**, and the whole select → decide → write runs inside the host's
   * `budget` permit, so the three steps are one critical section.
   *
   * ⚠️ **The serialization is the point, not a nicety.** Unserialized, N fibers entering for one host all
   * read the SAME row before any of them writes, all compute the same `count + 1` and the same `fireAt`,
   * and the last `onConflictDoUpdate` overwrites the others with an identical value: N reads charge the
   * daily counter ONCE and spend ONE token, so `HOST_DAILY_LIMIT` is silently multiplied by the fan-out
   * and all N wake from the same jittered wait together — the swarm this module exists to prevent, on the
   * surface the shipped Traffic-limits panel promises to enforce. `fetch-pace.decide` charges the slot
   * FORWARD (`updatedAt = fireAt`) so the next decider queues behind this one rather than beside it; that
   * only works when the next decider READS this one's write, which is exactly what the permit guarantees.
   */
  const charge = (lane: HostLane, host: string, limits: WebFetchPace.Limits) =>
    lane.budget.withPermits(1)(
      Effect.gen(function* () {
        const row = yield* deps.db
          .select()
          .from(WebHostBudgetTable)
          .where(eq(WebHostBudgetTable.host, host))
          .get()
          .pipe(Effect.orDie)
        const state = row
          ? { day: row.day, count: row.count, tokens: row.tokens, updatedAt: row.updated_at }
          : undefined
        // The clock is read as LATE as possible — immediately before the decision that uses it, and
        // after the row it is compared against. It is also the one step in here a test can make
        // suspend, which is how `test/web-governor-concurrency.test.ts` gets a negative control for
        // the permit above without a probe in this file: park a fiber between the read and the write,
        // and an unserialized version loses the count.
        const now = yield* deps.now()
        const decision = WebFetchPace.decide(state, now, limits)
        // A denial spends nothing, so there is nothing to persist.
        if (decision.kind === "deny") return decision

        // Persist BEFORE releasing the permit and before sleeping: the slot is claimed the moment it is
        // decided, so neither a concurrent read nor a crash mid-wait can reuse it.
        yield* deps.db
          .insert(WebHostBudgetTable)
          .values({
            host,
            day: decision.state.day,
            count: decision.state.count,
            tokens: decision.state.tokens,
            updated_at: decision.state.updatedAt,
          })
          .onConflictDoUpdate({
            target: WebHostBudgetTable.host,
            set: {
              day: decision.state.day,
              count: decision.state.count,
              tokens: decision.state.tokens,
              updated_at: decision.state.updatedAt,
            },
          })
          .run()
          .pipe(Effect.orDie)
        return decision
      }),
    )

  const guard: Interface["guard"] = (input) =>
    Effect.gen(function* () {
      // A malformed URL is the caller's problem, not the governor's — let the fetch report it.
      let host = ""
      try {
        host = WebFetchPace.hostOf(input.url)
      } catch {
        host = ""
      }
      if (host === "") return yield* input.fetch

      const limits = yield* deps.limits()

      // 1. Loop guard first — cheapest, and a looping agent should not even consume a token.
      //
      // This read-modify-write needs no lock, and the reason is structural rather than lucky: there is no
      // `yield*` between the `get` and the `set` on the path that reaches the `set`, so a fiber cannot
      // suspend inside it. Keep it that way — adding an await in the middle re-opens the same race the
      // budget below had to be serialized against.
      const key = `${input.sessionID ?? "-"}::${input.url}`
      const count = seen.get(key) ?? 0
      if (WebFetchPace.isLoop(count, limits.sameUrlLimit && limits.sameUrlLimit > 0 ? limits.sameUrlLimit : undefined))
        return yield* Effect.fail(
          new WebBudgetError(input.loopReason?.(count) ?? WebFetchPace.loopReason(input.url, count)),
        )
      seen.set(key, count + 1)

      const lane = laneFor(host, limits.perHostConcurrency ?? 1)

      // 2. Pace + daily cap, against the durable per-host row — serialized per host (see `charge`).
      const decision = yield* charge(lane, host, limits)
      if (decision.kind === "deny") return yield* Effect.fail(new WebBudgetError(decision.reason))

      // The wait is OUTSIDE the budget permit: the slot is already claimed and written, so holding the
      // lock through a multi-second sleep would only stall the next decider's bookkeeping without
      // protecting anything.
      const wait = WebFetchPace.jitter(decision.waitMs, deps.random)
      if (wait > 0) yield* deps.sleep(wait)

      // 3. Hold the host's slot for the duration of the fetch itself.
      return yield* lane.inflight.withPermits(1)(input.fetch)
    })

  return { guard }
}

export interface ResolvedLimits extends WebFetchPace.Limits {
  readonly perHostConcurrency?: number
  readonly sameUrlLimit?: number
}

/**
 * Map the live `web_search.throttle` block onto the policy's `Limits`. Read on EVERY call, so a settings
 * change takes effect with no restart (same contract the websearch service uses). A missing block, or a
 * `0` (the settings surface's "use default" sentinel), simply falls through to the defaults.
 */
export const readLimits = (raw: unknown): ResolvedLimits => {
  const throttle = ((raw ?? {}) as { throttle?: Record<string, unknown> }).throttle
  if (!throttle) return {}
  const num = (key: string): number | undefined => {
    const value = throttle[key]
    return typeof value === "number" && Number.isFinite(value) ? value : undefined
  }
  return {
    ...(num("hostIntervalMs") !== undefined ? { intervalMs: num("hostIntervalMs")! } : {}),
    ...(num("burst") !== undefined ? { burst: num("burst")! } : {}),
    ...(num("dailyPerHost") !== undefined ? { dailyLimit: num("dailyPerHost")! } : {}),
    ...(num("perHostConcurrency") !== undefined ? { perHostConcurrency: num("perHostConcurrency")! } : {}),
    ...(num("sameUrlLimit") !== undefined ? { sameUrlLimit: num("sameUrlLimit")! } : {}),
  }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const settings = yield* SettingsConfigStore.Service
    return Service.of(
      make({
        db,
        limits: () =>
          Effect.gen(function* () {
            const all = yield* settings.all().pipe(Effect.orElseSucceed(() => ({}) as Record<string, unknown>))
            return readLimits(all["web_search"])
          }),
        now: () => Effect.clockWith((clock) => clock.currentTimeMillis),
        sleep: (ms) => Effect.sleep(Duration.millis(ms)),
        random: () => Math.random(),
      }),
    )
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node, SettingsConfigStore.node] })
