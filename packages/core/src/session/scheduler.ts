/**
 * The session scheduler (Tier-1 roadmap item; design: notes/scheduler.md).
 *
 * V1 = the ADMISSION GATE at turn boundaries, per device (provider/model):
 *   - interactive sessions dispatch immediately (vLLM's continuous batching handles
 *     concurrency; their latency comes from never waiting client-side);
 *   - batch-class sessions (sub-agent, auto-prompting, goal-oriented, cron) wait while
 *     ANY interactive turn is generating, and are capped at MAX_BATCH concurrent turns
 *     — "background agents run on idle device cycles", enforced at the only preemption
 *     point a non-preemptible turn has: before dispatch;
 *   - among waiting batch sessions the TG-EEVDF ledger picks (fair share by class
 *     weight, structural aging — no starvation) with a bounded cache-affinity bonus
 *     for the most-recently-dispatched session (hysteresis, never override);
 *   - the slot covers GENERATION only: it is released before tool settlement, so a
 *     parent blocking on the `wait` tool never holds the device against its own child
 *     (the deadlock the bracket placement exists to prevent);
 *   - the ledger is BOUNDED by retention, not by session removal: `admit` is the only
 *     insertion point and it fires every turn, so before `evict` had a caller a ledger
 *     entry outlived its session, and even with one an idle-but-alive session kept its
 *     entry for the life of the instance. `release` now stamps the ledger's block clock
 *     and both growth paths sweep entries whose block outlived the forgiveness TTL —
 *     lazily, no daemon (the `trash.ts` stance). Debt is kept for exactly the window the
 *     ledger says it is kept for; after that forgiveness makes the entry a no-op anyway.
 *
 * The session's `priority` field (shipped with K1, previously unread) becomes the
 * EEVDF weight override: priority > 0 replaces the class weight.
 *
 * Kill switch: NOVACLAW_DISABLE_SCHEDULER=1/true → every admit is immediate.
 */
export * as SessionScheduler from "./scheduler"

import { Context, Deferred, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { KernelEevdf } from "../kernel/eevdf"

export const MAX_BATCH = 2
/** Warmth granted to the most-recently-dispatched session (v1 recency model). */
export const RECENCY_WARMTH_TOKENS = 6_000

export type SessionClass = KernelEevdf.SessionClass

export const isInteractive = (sessionClass: SessionClass) =>
  sessionClass === "interactive" || sessionClass === "interactive-focused"

/** SessionConfig.type → scheduler class ("interactive" covers the focused split later). */
export function classForSessionType(type: string | undefined): SessionClass {
  switch (type) {
    case "sub-agent":
      return "sub-agent"
    case "auto-prompting":
      return "auto-prompting"
    case "goal-oriented":
      return "goal-oriented"
    default:
      return "interactive"
  }
}

export interface AdmitInput {
  readonly sessionID: string
  readonly deviceKey: string
  readonly sessionClass: SessionClass
  /** K1 priority: > 0 overrides the class weight (EEVDF share). */
  readonly priority?: number
}

export interface ReleaseInput {
  readonly sessionID: string
  readonly deviceKey: string
}

export interface ReportInput extends ReleaseInput {
  readonly costTokens: number
}

export interface DeviceSnapshot {
  readonly deviceKey: string
  readonly inFlightInteractive: readonly string[]
  readonly inFlightBatch: readonly string[]
  readonly waiting: readonly string[]
  readonly ledger: ReturnType<KernelEevdf.Ledger["snapshot"]>
}

export interface Interface {
  /** Returns when the session may dispatch its next turn on the device. */
  readonly admit: (input: AdmitInput) => Effect.Effect<void>
  /** Idempotent. Frees the slot and drains waiters. */
  readonly release: (input: ReleaseInput) => Effect.Effect<void>
  /** Charge the finished turn's measured cost to the fairness ledger. */
  readonly report: (input: ReportInput) => Effect.Effect<void>
  /** Session ended: drop it from ledgers/queues. */
  readonly evict: (sessionID: string) => Effect.Effect<void>
  /** Introspection (the ps-app story): one query surface for humans, agents, tests. */
  readonly snapshot: () => Effect.Effect<readonly DeviceSnapshot[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionScheduler") {}

interface Waiter {
  readonly deferred: Deferred.Deferred<void>
}

interface DeviceState {
  readonly ledger: KernelEevdf.Ledger
  readonly inFlightInteractive: Set<string>
  readonly inFlightBatch: Set<string>
  readonly waiters: Map<string, Waiter>
  lastDispatched?: string
}

const disabled = () => {
  const value = process.env.NOVACLAW_DISABLE_SCHEDULER?.toLowerCase()
  return value === "1" || value === "true"
}

/** Injectable seams (tests): a fake clock and a shortened forgiveness/retention TTL. */
export interface Options {
  /** Wall-clock ms — the ledger's block/forgiveness window is wall time, not virtual time. */
  readonly now?: () => number
  readonly forgivenessMs?: number
}

export const make = (options?: Options): Interface => {
  const devices = new Map<string, DeviceState>()
  const now = options?.now ?? (() => Date.now())
  const forgivenessMs = options?.forgivenessMs

  const deviceFor = (key: string): DeviceState => {
    let device = devices.get(key)
    if (!device)
      devices.set(
        key,
        (device = {
          ledger: new KernelEevdf.Ledger(forgivenessMs === undefined ? undefined : { forgivenessMs }),
          inFlightInteractive: new Set(),
          inFlightBatch: new Set(),
          waiters: new Map(),
        }),
      )
    return device
  }

  /**
   * Lazy retention, called from the two paths that can GROW a device: `admit` (the only
   * insertion point) and `release` (the only place a session stops holding the device). No
   * daemon and no wall-clock timer — a quiet instance simply has nothing to dilute. Anything
   * this gate still tracks is pinned, so a queued waiter can never lose the ledger entry
   * `drain` needs to pick it.
   */
  const sweep = (device: DeviceState) =>
    device.ledger.sweepForgiven(
      now(),
      (id) => device.inFlightInteractive.has(id) || device.inFlightBatch.has(id) || device.waiters.has(id),
    )

  const batchCapacity = (device: DeviceState) =>
    device.inFlightInteractive.size === 0 && device.inFlightBatch.size < MAX_BATCH

  const drain = (device: DeviceState) => {
    while (batchCapacity(device) && device.waiters.size > 0) {
      const candidates = [...device.waiters.keys()].map((id) => ({
        id,
        warmthTokens: id === device.lastDispatched ? RECENCY_WARMTH_TOKENS : 0,
      }))
      const pick = device.ledger.pick(candidates)
      if (!pick) return
      const waiter = device.waiters.get(pick)!
      device.waiters.delete(pick)
      device.inFlightBatch.add(pick)
      device.lastDispatched = pick
      Deferred.doneUnsafe(waiter.deferred, Effect.void)
    }
  }

  const admit = (input: AdmitInput): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (disabled()) return Effect.void
      const device = deviceFor(input.deviceKey)
      sweep(device)
      device.ledger.ensure(
        input.sessionID,
        input.sessionClass,
        input.priority && input.priority > 0 ? { weight: input.priority } : undefined,
      )
      // Running again: a brief block keeps its debt, a block past the forgiveness TTL is
      // forgiven here. The sweep above usually got there first — but on an instance where
      // this session is the ONLY traffic, no sweep ever runs, and the policy must still hold.
      device.ledger.onWake(input.sessionID, now())
      const alreadyInFlight =
        device.inFlightInteractive.has(input.sessionID) || device.inFlightBatch.has(input.sessionID)
      if (alreadyInFlight) return Effect.void
      if (isInteractive(input.sessionClass)) {
        device.inFlightInteractive.add(input.sessionID)
        device.lastDispatched = input.sessionID
        return Effect.void
      }
      if (batchCapacity(device)) {
        device.inFlightBatch.add(input.sessionID)
        device.lastDispatched = input.sessionID
        return Effect.void
      }
      const deferred = Deferred.makeUnsafe<void>()
      device.waiters.set(input.sessionID, { deferred })
      return Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            device.waiters.delete(input.sessionID)
            // A cancelled queued turn never reaches `release`, so stamp the block here too —
            // otherwise its entry sits unblocked forever and no sweep can ever see it.
            device.ledger.onBlock(input.sessionID, now())
          }),
        ),
      )
    })

  const release = (input: ReleaseInput): Effect.Effect<void> =>
    Effect.sync(() => {
      const device = devices.get(input.deviceKey)
      if (!device) return
      const held = device.inFlightInteractive.delete(input.sessionID) || device.inFlightBatch.delete(input.sessionID)
      if (!held) return
      // The session has stopped holding the device: start its block clock, so its debt is kept
      // for the forgiveness window and its entry is swept once that window closes. Gated on
      // `held` because `release` runs twice per turn (in-band, then the `ensuring` net) and the
      // second call must not restart the clock.
      device.ledger.onBlock(input.sessionID, now())
      sweep(device)
      drain(device)
    })

  const report = (input: ReportInput): Effect.Effect<void> =>
    Effect.sync(() => {
      devices.get(input.deviceKey)?.ledger.charge(input.sessionID, input.costTokens)
    })

  const evict = (sessionID: string): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const device of devices.values()) {
        device.ledger.remove(sessionID)
        device.inFlightInteractive.delete(sessionID)
        device.inFlightBatch.delete(sessionID)
        const waiter = device.waiters.get(sessionID)
        if (waiter) {
          device.waiters.delete(sessionID)
          Deferred.doneUnsafe(waiter.deferred, Effect.void)
        }
        drain(device)
      }
    })

  // Deliberately does NOT sweep: this is the Debug app's and the tests' read surface, and a
  // read never destroys (todo.md ruling 3). Retention rides the write paths only.
  const snapshot = (): Effect.Effect<readonly DeviceSnapshot[]> =>
    Effect.sync(() =>
      [...devices.entries()].map(([deviceKey, device]) => ({
        deviceKey,
        inFlightInteractive: [...device.inFlightInteractive],
        inFlightBatch: [...device.inFlightBatch],
        waiting: [...device.waiters.keys()],
        ledger: device.ledger.snapshot(),
      })),
    )

  return { admit, release, report, evict, snapshot }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
