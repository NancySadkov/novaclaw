/**
 * The runner's SESSION-scoped controller state, as a service the executor can put where it belongs.
 *
 * 🔴 The maps in `llm.ts` carry facts the drives need across DRAINS: the latched set request, every
 * file the set has opened and attempted, the barren-round counter, the children joined, the restart
 * rounds. Each was moved out of a drain local after a measured failure (runs 12, 13 and 15 of the
 * set drive) and documented as "session-scoped, this process". That was true for the in-process
 * executor the tests build once — and false in production, where `SessionExecutionWorker` builds
 * the runner layer inside ONE drain and disposes it in `finally`: every steer starts a new worker,
 * and every one of those maps was a drain local again, wearing a comment that said otherwise.
 *
 * So the state lives behind this service. The default implementation is the in-memory store with
 * the scheduler's forgiveness window (`SessionMapRetention`), which is the right lifetime in the
 * one process that outlives a drain: the host. The worker replaces this node with an RPC client
 * (`session-worker/services.ts`), so the maps in `llm.ts` become a per-drain cache that is HYDRATED
 * from here when a run starts and FLUSHED here on every write.
 *
 * ⚠️ Pinning. `withSession` pins a session against the sweep for the duration of one Effect; `pin`
 * and `unpin` are its two halves for a run that is not one Effect. Under the worker executor the
 * HOST pins the drain around the worker's whole life (`session-worker/execution.ts`), because only
 * the host knows when that run really ends; the worker-side client's three pinning calls are
 * pass-throughs for that reason, not omissions.
 */
export * as SessionDriveState from "./drive-state"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionMapRetention } from "./session-map-retention"

/** One session's controller facts, JSON-shaped so a worker can carry them over the line protocol. */
export interface Snapshot {
  /** The set request latched on turn one — `llm.ts` `setRequests`. */
  readonly request?: {
    readonly asked: boolean
    readonly limit?: number
    readonly named?: ReadonlyArray<string>
  }
  /** Files the set has successfully opened, accumulated — `setOpened`. */
  readonly opened: ReadonlyArray<string>
  /** Every path the set has attempted, successful or not — `setAttempted`. */
  readonly attempted: ReadonlyArray<string>
  /** Consecutive steer rounds that opened nothing new — `setBarrenBySession`. */
  readonly barren?: { readonly barren: number; readonly lastOpened: number }
  /** Children this session has joined — `childrenJoined`. */
  readonly joined: ReadonlyArray<string>
  /** Times the session was steered back to unaccounted children — `childRestartRounds`. */
  readonly restartRounds: number
  /** Tool-call count at which the broad runaway warning fired for this durable user-task span. */
  readonly runawayNudgedAtCalls: number
  /** Automatic compaction backoff after a summary model failed to answer. */
  readonly compactionRetryAt?: number
}

export const empty: Snapshot = { opened: [], attempted: [], joined: [], restartRounds: 0, runawayNudgedAtCalls: 0 }

const stringArray = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((item) => typeof item === "string")

/**
 * Read a snapshot that crossed a process boundary, as a whole or not at all. A snapshot that lost a
 * field in transit must not become a session that forgot what it opened.
 */
export const decode = (raw: unknown): Snapshot | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (!stringArray(value.opened) || !stringArray(value.attempted) || !stringArray(value.joined)) return undefined
  if (typeof value.restartRounds !== "number") return undefined
  // Older persisted controller snapshots predate the runaway latch. Preserve their set-drive and
  // join state while defaulting only the new watermark; a harness upgrade must not erase unrelated
  // recovery state merely because it learned one more field.
  const runawayNudgedAtCalls = value.runawayNudgedAtCalls === undefined ? 0 : value.runawayNudgedAtCalls
  if (typeof runawayNudgedAtCalls !== "number" || !Number.isFinite(runawayNudgedAtCalls)) return undefined
  if (value.compactionRetryAt !== undefined && typeof value.compactionRetryAt !== "number") return undefined
  let request: Snapshot["request"]
  if (value.request !== undefined) {
    const r = value.request as Record<string, unknown> | null
    if (typeof r !== "object" || r === null || typeof r.asked !== "boolean") return undefined
    if (r.limit !== undefined && typeof r.limit !== "number") return undefined
    if (r.named !== undefined && !stringArray(r.named)) return undefined
    request = {
      asked: r.asked,
      ...(r.limit === undefined ? {} : { limit: r.limit }),
      ...(r.named === undefined ? {} : { named: r.named }),
    }
  }
  let barren: Snapshot["barren"]
  if (value.barren !== undefined) {
    const b = value.barren as Record<string, unknown> | null
    if (typeof b !== "object" || b === null || typeof b.barren !== "number" || typeof b.lastOpened !== "number")
      return undefined
    barren = { barren: b.barren, lastOpened: b.lastOpened }
  }
  return {
    ...(request === undefined ? {} : { request }),
    opened: value.opened,
    attempted: value.attempted,
    ...(barren === undefined ? {} : { barren }),
    joined: value.joined,
    restartRounds: value.restartRounds,
    runawayNudgedAtCalls,
    ...(value.compactionRetryAt === undefined ? {} : { compactionRetryAt: value.compactionRetryAt }),
  }
}

export interface Interface {
  /** The session's facts, or `empty` for a session this store has never seen (or has swept). */
  readonly load: (sessionID: string) => Effect.Effect<Snapshot>
  /** Replace the session's facts. Every write in `llm.ts` flushes the whole snapshot. */
  readonly save: (sessionID: string, snapshot: Snapshot) => Effect.Effect<void>
  /** Pin the session against the idle sweep while `effect` runs. */
  readonly withSession: <A, E, R>(sessionID: string, effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** `withSession`'s two halves, for a run that is not one Effect. Always paired. */
  readonly pin: (sessionID: string) => Effect.Effect<void>
  readonly unpin: (sessionID: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/SessionDriveState") {}

/**
 * The in-memory store. One `Map`, swept by the scheduler's forgiveness window so a completed session
 * is not a process-lifetime allocation, and pinned by `withSession` / `pin` while a run is live.
 */
export const make = (options?: SessionMapRetention.Options): Interface => {
  const snapshots = new Map<string, Snapshot>()
  const retention = SessionMapRetention.make([snapshots], options)
  return {
    load: (sessionID) => Effect.sync(() => snapshots.get(sessionID) ?? empty),
    save: (sessionID, snapshot) =>
      Effect.sync(() => {
        snapshots.set(sessionID, snapshot)
      }),
    withSession: retention.withSession,
    pin: (sessionID) => Effect.sync(() => retention.acquire(sessionID)),
    unpin: (sessionID) => Effect.sync(() => retention.release(sessionID)),
  }
}

export const layer = Layer.sync(Service, () => Service.of(make()))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
