/**
 * The session scheduler (Tier-1 roadmap item; design: notes/reports/scheduler-synthesis-2026-07-03.md).
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
import type { ConfigDevice } from "../config/device"
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
  /** Device-declared concurrent background generation cap; defaults to the conservative floor. */
  readonly concurrency?: number
  /** Operator-declared placement fact, exposed in snapshots for routing and diagnosis. */
  readonly locality?: ConfigDevice.Locality
}

export interface ReleaseInput {
  readonly sessionID: string
  readonly deviceKey: string
}

export interface ReportInput extends ReleaseInput {
  readonly costTokens: number
}

/**
 * Decode-shaped housekeeping is not a session turn, but it consumes the same device bus.
 * `ownerID` keeps diagnostics and queued-work eviction tied to the session whose maintenance
 * produced the call; `task` is a short human-readable discriminator for snapshots.
 */
export interface MaintenanceInput {
  readonly ownerID: string
  readonly task: string
  readonly deviceKey: string
  /** Shares the device's background-generation ceiling with batch session turns. */
  readonly concurrency?: number
  readonly locality?: ConfigDevice.Locality
}

/** Opaque scheduler-owned identity returned after maintenance admission succeeds. */
export interface MaintenanceLease extends ReleaseInput {
  readonly maintenanceID: string
}

export interface MaintenanceReleaseInput {
  readonly ownerID: string
  readonly lease: MaintenanceLease
}

export interface DeviceSnapshot {
  readonly deviceKey: string
  readonly concurrency: number
  readonly locality?: ConfigDevice.Locality
  readonly inFlightInteractive: readonly string[]
  readonly inFlightBatch: readonly string[]
  readonly inFlightMaintenance: readonly string[]
  readonly waiting: readonly string[]
  readonly waitingMaintenance: readonly string[]
  readonly ledger: ReturnType<KernelEevdf.Ledger["snapshot"]>
}

export interface Interface {
  /** Returns when the session may dispatch its next turn on the device. */
  readonly admit: (input: AdmitInput) => Effect.Effect<void>
  /** Idempotent. Frees the slot and drains waiters. */
  readonly release: (input: ReleaseInput) => Effect.Effect<void>
  /** Charge the finished turn's measured cost to the fairness ledger. */
  readonly report: (input: ReportInput) => Effect.Effect<void>
  /** Acquire one unique interactive-idle maintenance lease. */
  readonly admitMaintenance: (input: MaintenanceInput) => Effect.Effect<MaintenanceLease>
  /** Completes when a newly admitted interactive turn asks this maintenance pass to yield. */
  readonly awaitMaintenancePreemption: (input: MaintenanceReleaseInput) => Effect.Effect<void>
  /** Release only a lease that belongs to the stated owner (worker RPCs cannot forge one). */
  readonly releaseMaintenance: (input: MaintenanceReleaseInput) => Effect.Effect<void>
  /** Session ended: drop it from ledgers/queues. */
  readonly evict: (sessionID: string) => Effect.Effect<void>
  /** Introspection (the ps-app story): one query surface for humans, agents, tests. */
  readonly snapshot: () => Effect.Effect<readonly DeviceSnapshot[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionScheduler") {}

interface Waiter {
  readonly deferred: Deferred.Deferred<void>
  readonly kind: "batch" | "maintenance"
}

interface DeviceState {
  readonly ledger: KernelEevdf.Ledger
  readonly inFlightInteractive: Set<string>
  readonly inFlightBatch: Set<string>
  readonly inFlightMaintenance: Set<string>
  readonly waiters: Map<string, Waiter>
  readonly maintenanceOwners: Map<string, string>
  readonly maintenancePreemptions: Map<string, Deferred.Deferred<void>>
  concurrency: number
  locality?: ConfigDevice.Locality
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
  let maintenanceSequence = 0

  const deviceFor = (key: string): DeviceState => {
    let device = devices.get(key)
    if (!device)
      devices.set(
        key,
        (device = {
          ledger: new KernelEevdf.Ledger(forgivenessMs === undefined ? undefined : { forgivenessMs }),
          inFlightInteractive: new Set(),
          inFlightBatch: new Set(),
          inFlightMaintenance: new Set(),
          waiters: new Map(),
          maintenanceOwners: new Map(),
          maintenancePreemptions: new Map(),
          concurrency: MAX_BATCH,
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
      (id) =>
        device.inFlightInteractive.has(id) ||
        device.inFlightBatch.has(id) ||
        device.inFlightMaintenance.has(id) ||
        device.waiters.has(id),
    )

  const batchCapacity = (device: DeviceState) =>
    device.inFlightInteractive.size === 0 &&
    device.inFlightBatch.size + device.inFlightMaintenance.size < device.concurrency

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
      if (waiter.kind === "maintenance") device.inFlightMaintenance.add(pick)
      else device.inFlightBatch.add(pick)
      device.lastDispatched = pick
      Deferred.doneUnsafe(waiter.deferred, Effect.void)
    }
  }

  const admitKind = (
    input: AdmitInput,
    kind: "batch" | "maintenance",
    maintenanceOwner?: string,
  ): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (disabled()) return Effect.void
      const device = deviceFor(input.deviceKey)
      if (maintenanceOwner !== undefined) device.maintenanceOwners.set(input.sessionID, maintenanceOwner)
      // Config is runtime-editable: the newest admission refreshes policy for the whole device.
      // Lowering the cap never preempts an in-flight generation; it simply closes admission until
      // the live count falls below the new ceiling.
      device.concurrency = input.concurrency ?? MAX_BATCH
      device.locality = input.locality
      sweep(device)
      // A raised cap belongs to the device, not to the newcomer that happened to carry it. Give
      // already-waiting sessions first claim through EEVDF before considering this admission.
      drain(device)
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
        device.inFlightInteractive.has(input.sessionID) ||
        device.inFlightBatch.has(input.sessionID) ||
        device.inFlightMaintenance.has(input.sessionID)
      if (alreadyInFlight) return Effect.void
      if (isInteractive(input.sessionClass)) {
        // Maintenance is deliberately interruptible. Continuous batching does not make a long
        // utility prefill free: on the Spark a compaction already in flight delayed a brand-new
        // interactive chat's first token by 150 seconds. Signal every acquired maintenance lease;
        // `runMaintenance` races its provider effect against this signal and aborts the request.
        const preempt = [...device.inFlightMaintenance]
        // Publish the interactive owner BEFORE waking another fiber. `Deferred.doneUnsafe` may
        // resume that fiber synchronously; its maintenance finalizer calls `drain`, which must see
        // the foreground owner and leave queued maintenance queued. Snapshot the ids too, so a
        // re-entrant drain cannot append a fresh lease to the Set iteration and cancel work that
        // never overlapped this arrival.
        device.inFlightInteractive.add(input.sessionID)
        device.lastDispatched = input.sessionID
        for (const maintenanceID of preempt) {
          const preemption = device.maintenancePreemptions.get(maintenanceID)
          if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
        }
        return Effect.void
      }
      if (batchCapacity(device)) {
        if (kind === "maintenance") device.inFlightMaintenance.add(input.sessionID)
        else device.inFlightBatch.add(input.sessionID)
        device.lastDispatched = input.sessionID
        return Effect.void
      }
      const deferred = Deferred.makeUnsafe<void>()
      device.waiters.set(input.sessionID, { deferred, kind })
      return Deferred.await(deferred).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            device.waiters.delete(input.sessionID)
            device.maintenanceOwners.delete(input.sessionID)
            // A cancelled queued turn never reaches `release`, so stamp the block here too —
            // otherwise its entry sits unblocked forever and no sweep can ever see it.
            device.ledger.onBlock(input.sessionID, now())
          }),
        ),
      )
    })

  const admit = (input: AdmitInput): Effect.Effect<void> => admitKind(input, "batch")

  const release = (input: ReleaseInput): Effect.Effect<void> =>
    Effect.sync(() => {
      const device = devices.get(input.deviceKey)
      if (!device) return
      const held =
        device.inFlightInteractive.delete(input.sessionID) ||
        device.inFlightBatch.delete(input.sessionID) ||
        device.inFlightMaintenance.delete(input.sessionID)
      if (!held) return
      device.maintenanceOwners.delete(input.sessionID)
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

  const admitMaintenance: Interface["admitMaintenance"] = (input) =>
    Effect.suspend(() => {
      // A session may have title, extraction and status work overlapping. A fresh identity per
      // invocation prevents the scheduler's idempotent re-admit rule from turning that overlap into
      // uncounted device concurrency.
      const taskID = `maintenance:${++maintenanceSequence}:${input.task}:${input.ownerID}`
      const slot: AdmitInput = {
        sessionID: taskID,
        deviceKey: input.deviceKey,
        sessionClass: "cron",
        ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
        ...(input.locality === undefined ? {} : { locality: input.locality }),
      }
      const device = deviceFor(input.deviceKey)
      device.maintenancePreemptions.set(taskID, Deferred.makeUnsafe<void>())
      return admitKind(slot, "maintenance", input.ownerID).pipe(
        Effect.as({ maintenanceID: taskID, sessionID: taskID, deviceKey: input.deviceKey }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            device.maintenancePreemptions.delete(taskID)
          }),
        ),
      )
    })

  const awaitMaintenancePreemption: Interface["awaitMaintenancePreemption"] = (input) =>
    Effect.suspend(() => {
      const device = devices.get(input.lease.deviceKey)
      if (device?.maintenanceOwners.get(input.lease.maintenanceID) !== input.ownerID) return Effect.void
      const preemption = device.maintenancePreemptions.get(input.lease.maintenanceID)
      return preemption === undefined ? Effect.void : Deferred.await(preemption)
    })

  const releaseMaintenance = (input: MaintenanceReleaseInput): Effect.Effect<void> =>
    Effect.suspend(() => {
      const device = devices.get(input.lease.deviceKey)
      if (device?.maintenanceOwners.get(input.lease.maintenanceID) !== input.ownerID) return Effect.void
      const preemption = device.maintenancePreemptions.get(input.lease.maintenanceID)
      if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
      device.maintenancePreemptions.delete(input.lease.maintenanceID)
      return release({ sessionID: input.lease.maintenanceID, deviceKey: input.lease.deviceKey })
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
          // Eviction revokes the queued turn's right to run. Only `drain` may complete an
          // admission successfully; otherwise deletion can wake its own worker into dispatch.
          Deferred.doneUnsafe(waiter.deferred, Effect.interrupt)
        }
        // Maintenance has its own unique task ids. Once the owner is evicted, neither a queued pass
        // nor an acquired lease may survive: worker-exit reclaim reaches this path after the worker
        // (and therefore its provider fiber) is gone, so leaving an acquired id here would consume
        // background capacity forever. Session removal interrupts execution before eviction too.
        for (const [taskID, ownerID] of device.maintenanceOwners) {
          if (ownerID !== sessionID) continue
          const maintenanceWaiter = device.waiters.get(taskID)
          device.maintenanceOwners.delete(taskID)
          const preemption = device.maintenancePreemptions.get(taskID)
          if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
          device.maintenancePreemptions.delete(taskID)
          device.inFlightMaintenance.delete(taskID)
          device.ledger.remove(taskID)
          if (!maintenanceWaiter) continue
          device.waiters.delete(taskID)
          Deferred.doneUnsafe(maintenanceWaiter.deferred, Effect.interrupt)
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
        concurrency: device.concurrency,
        ...(device.locality === undefined ? {} : { locality: device.locality }),
        inFlightInteractive: [...device.inFlightInteractive],
        inFlightBatch: [...device.inFlightBatch],
        inFlightMaintenance: [...device.inFlightMaintenance],
        waiting: [...device.waiters.keys()],
        waitingMaintenance: [...device.waiters].filter(([, waiter]) => waiter.kind === "maintenance").map(([id]) => id),
        ledger: device.ledger.snapshot(),
      })),
    )

  return { admit, release, report, admitMaintenance, awaitMaintenancePreemption, releaseMaintenance, evict, snapshot }
}

/**
 * Bracket a local provider effect with a scheduler-owned maintenance lease. Only the lease crosses
 * a session-worker boundary; the provider effect remains in the process that owns its stream.
 */
export const runMaintenance = <A, E, R>(
  scheduler: Interface,
  input: MaintenanceInput,
  effect: Effect.Effect<A, E, R>,
  onPreempt: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.acquireUseRelease(
    scheduler.admitMaintenance(input),
    (lease) =>
      Effect.raceFirst(
        effect,
        scheduler.awaitMaintenancePreemption({ ownerID: input.ownerID, lease }).pipe(Effect.andThen(onPreempt)),
      ),
    (lease) => scheduler.releaseMaintenance({ ownerID: input.ownerID, lease }),
  )

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
