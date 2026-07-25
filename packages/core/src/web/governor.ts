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

export const make = (deps: Deps): Interface => {
  // One semaphore per host — the "no parallel streams at one site" rule.
  const gates = new Map<string, Semaphore.Semaphore>()
  // sessionID+url -> times fetched. Process-local: a loop happens within a run.
  const seen = new Map<string, number>()

  const gateFor = (host: string, permits: number) =>
    Effect.gen(function* () {
      const existing = gates.get(host)
      if (existing) return existing
      const created = yield* Semaphore.make(Math.max(1, permits))
      gates.set(host, created)
      return created
    })

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
      const key = `${input.sessionID ?? "-"}::${input.url}`
      const count = seen.get(key) ?? 0
      if (WebFetchPace.isLoop(count, limits.sameUrlLimit && limits.sameUrlLimit > 0 ? limits.sameUrlLimit : undefined))
        return yield* Effect.fail(new WebBudgetError(WebFetchPace.loopReason(input.url, count)))
      seen.set(key, count + 1)

      // 2. Pace + daily cap, against the durable per-host row.
      const now = yield* deps.now()
      const row = yield* deps.db
        .select()
        .from(WebHostBudgetTable)
        .where(eq(WebHostBudgetTable.host, host))
        .get()
        .pipe(Effect.orDie)
      const state = row
        ? { day: row.day, count: row.count, tokens: row.tokens, updatedAt: row.updated_at }
        : undefined
      const decision = WebFetchPace.decide(state, now, limits)
      if (decision.kind === "deny") return yield* Effect.fail(new WebBudgetError(decision.reason))

      // Persist BEFORE sleeping: the slot is claimed the moment it is decided, so a concurrent read (or a
      // crash mid-wait) can never reuse it.
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

      const wait = WebFetchPace.jitter(decision.waitMs, deps.random)
      if (wait > 0) yield* deps.sleep(wait)

      // 3. Hold the host's slot for the duration of the fetch itself.
      const gate = yield* gateFor(host, limits.perHostConcurrency ?? 1)
      return yield* gate.withPermits(1)(input.fetch)
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
