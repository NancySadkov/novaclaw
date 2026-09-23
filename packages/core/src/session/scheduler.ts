/**
 * The session scheduler (Tier-1 roadmap item; design: notes/reports/scheduler-synthesis-2026-07-03.md).
 *
 * V1 = the ADMISSION GATE at turn boundaries, per device (provider/model):
 *   - Nova always owns the governing lane; on a chat screen the human-visible chat is next, while
 *     Home grants no ordinary chat foreground priority (vLLM still continuously batches them);
 *   - batch-class sessions (sub-agent, auto-prompting, goal-oriented, cron) wait while
 *     the human-visible foreground turn is generating, and all generation classes together are
 *     capped at the device's concurrency limit
 *     — "background agents run on idle device cycles";
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
import { SettingsConfigStore } from "../settings-config-store"
import { makeGlobalNode } from "../effect/app-node"
import { KernelEevdf } from "../kernel/eevdf"

export const MAX_BATCH = 4
/** Warmth granted to the most-recently-dispatched session (v1 recency model). */
export const RECENCY_WARMTH_TOKENS = 6_000

export type SessionClass = KernelEevdf.SessionClass

export const isInteractive = (sessionClass: SessionClass) =>
  sessionClass === "interactive" || sessionClass === "interactive-focused"

/** Only an actually attached human makes an ordinary chat focused; Nova is handled separately. */
export const isFocused = (sessionClass: SessionClass) => sessionClass === "interactive-focused"

export const hasHumanViewer = (presence: { readonly viewers: readonly { readonly kind: string }[] }) =>
  presence.viewers.some((viewer) => viewer.kind === "human")

/** Nova always owns the governing lane; another chat owns it only while a human is viewing it. */
export const hasForegroundPriority = (
  agent: string | undefined,
  presence: { readonly viewers: readonly { readonly kind: string }[] },
) => agent === "nova" || hasHumanViewer(presence)

export const focusClass = (sessionClass: SessionClass, focused: boolean): SessionClass =>
  focused ? "interactive-focused" : sessionClass === "interactive-focused" ? "interactive" : sessionClass

/** SessionConfig.type → base scheduler class; the host promotes live human presence separately. */
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
  /** Device-declared concurrent generation cap; defaults to the conservative floor. */
  readonly concurrency?: number
  /**
   * Minimum ms the most-recently-dispatched session holds this device across its own turns.
   * Absent means "this caller has no new policy" — it must never reset an operator-set window.
   */
  readonly minRunMs?: number
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
  /** Shares the device's generation ceiling with session turns. */
  readonly concurrency?: number
  readonly minRunMs?: number
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
  readonly minRunMs: number
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
  readonly transferRelease: (input: ReleaseInput) => Effect.Effect<void>
  readonly awaitRevocation: (input: ReleaseInput) => Effect.Effect<boolean>
  readonly syncDevices: (entries: Readonly<Record<string, { readonly concurrency?: number }>>) => Effect.Effect<void>
  readonly refreshDevices: () => Effect.Effect<void>
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
  readonly kind: "interactive" | "batch" | "maintenance"
}

interface DeviceState {
  readonly ledger: KernelEevdf.Ledger
  readonly inFlightInteractive: Set<string>
  readonly inFlightBatch: Set<string>
  readonly inFlightMaintenance: Set<string>
  readonly waiters: Map<string, Waiter>
  readonly maintenanceOwners: Map<string, string>
  readonly maintenancePreemptions: Map<string, Deferred.Deferred<void>>
  readonly revocations: Map<string, Deferred.Deferred<boolean>>
  concurrency: number
  /** Cache-affinity window in ms; see `ConfigDevice.Info.minRunMs`. 0 disables the warm cohort. */
  minRunMs: number
  locality?: ConfigDevice.Locality
  lastDispatched?: string
  /**
   * sessionID → wall-clock ms of its most recent dispatch on this device. The WARM COHORT is the
   * waiters whose last run is still inside `minRunMs`: they keep the device over a cold peer, so a
   * memory-mapped context is not evicted the moment its owner's next turn queues. Bounded by the
   * same lazy sweep as the ledger; an entry older than the window can no longer matter.
   */
  readonly recent: Map<string, number>
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
  const configuredConcurrency = new Map<string, number>()
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
          revocations: new Map(),
          concurrency: configuredConcurrency.get(key) ?? MAX_BATCH,
          minRunMs: 0,
          recent: new Map(),
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
  const sweep = (device: DeviceState) => {
    device.ledger.sweepForgiven(
      now(),
      (id) =>
        device.inFlightInteractive.has(id) ||
        device.inFlightBatch.has(id) ||
        device.inFlightMaintenance.has(id) ||
        device.waiters.has(id),
    )
    if (device.minRunMs > 0) {
      const cutoff = now() - device.minRunMs
      for (const [id, at] of device.recent) if (at <= cutoff) device.recent.delete(id)
    }
  }

  const inFlight = (device: DeviceState) =>
    device.inFlightInteractive.size + device.inFlightBatch.size + device.inFlightMaintenance.size

  const revokeExcess = (device: DeviceState) => {
    let excess = inFlight(device) - device.concurrency
    if (excess <= 0) return
    for (const id of [
      ...[...device.inFlightMaintenance].reverse(),
      ...[...device.inFlightBatch].reverse(),
      ...[...device.inFlightInteractive].reverse(),
    ]) {
      const revocation = device.revocations.get(id)
      if (revocation === undefined) continue
      if (Deferred.doneUnsafe(revocation, Effect.succeed(true))) {
        const maintenance = device.maintenancePreemptions.get(id)
        if (maintenance) Deferred.doneUnsafe(maintenance, Effect.void)
        excess--
      }
      if (excess <= 0) break
    }
  }

  const syncDevices: Interface["syncDevices"] = (entries) =>
    Effect.sync(() => {
      for (const id of new Set([...configuredConcurrency.keys(), ...Object.keys(entries)])) {
        const concurrency = entries[id]?.concurrency ?? MAX_BATCH
        configuredConcurrency.set(id, concurrency)
        const device = devices.get(id)
        if (device === undefined) continue
        device.concurrency = concurrency
        revokeExcess(device)
        drain(device)
      }
    })

  const interactiveWaiters = (device: DeviceState) =>
    [...device.waiters].filter(([, waiter]) => waiter.kind === "interactive").map(([id]) => id)

  const batchCapacity = (device: DeviceState) =>
    device.inFlightInteractive.size === 0 &&
    interactiveWaiters(device).length === 0 &&
    inFlight(device) < device.concurrency

  const drain = (device: DeviceState) => {
    while (inFlight(device) < device.concurrency && device.waiters.size > 0) {
      const foreground = interactiveWaiters(device)
      if (foreground.length === 0 && !batchCapacity(device)) return
      let eligible = foreground.length > 0 ? foreground : [...device.waiters.keys()]
      // Cache-affinity window: among the batch waiters, prefer the WARM COHORT — sessions that ran
      // within `minRunMs` — over a cold peer whose context would evict the resident pages. This is a
      // preference among waiters, never a reservation: if nobody waiting ran recently, the device is
      // handed on normally rather than left idle. A foreground waiter always outranks it (the owner's
      // interactive turn is never delayed for affinity).
      if (foreground.length === 0 && device.minRunMs > 0) {
        const cutoff = now() - device.minRunMs
        const warm = eligible.filter((id) => {
          const at = device.recent.get(id)
          return at !== undefined && at > cutoff
        })
        if (warm.length > 0) eligible = warm
      }
      const candidates = eligible.map((id) => ({
        id,
        warmthTokens: id === device.lastDispatched ? RECENCY_WARMTH_TOKENS : 0,
      }))
      const pick = device.ledger.pick(candidates)
      if (!pick) return
      const waiter = device.waiters.get(pick)!
      device.waiters.delete(pick)
      if (waiter.kind === "interactive") device.inFlightInteractive.add(pick)
      else if (waiter.kind === "maintenance") device.inFlightMaintenance.add(pick)
      else device.inFlightBatch.add(pick)
      device.lastDispatched = pick
      device.recent.set(pick, now())
      Deferred.doneUnsafe(waiter.deferred, Effect.void)
    }
  }

  const queue = (device: DeviceState, input: AdmitInput, kind: Waiter["kind"]): Effect.Effect<void> => {
    const deferred = Deferred.makeUnsafe<void>()
    device.waiters.set(input.sessionID, { deferred, kind })
    return Deferred.await(deferred).pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          device.waiters.delete(input.sessionID)
          device.revocations.delete(input.sessionID)
          device.maintenanceOwners.delete(input.sessionID)
          // A cancelled queued turn never reaches `release`, so stamp the block here too —
          // otherwise its entry sits unblocked forever and no sweep can ever see it.
          device.ledger.onBlock(input.sessionID, now())
        }),
      ),
    )
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
      // Config is runtime-editable: an admission that CARRIES policy refreshes it for the whole
      // device. A lower cap revokes excess active generations and closes admission until they exit.
      //
      // 🔴 An admission that does NOT carry a concurrency must never WIDEN the cap. This was
      // `device.concurrency = input.concurrency ?? MAX_BATCH`, so one request whose device profile
      // had not resolved (a reasoning-phase lease, a maintenance pass, a model whose endpoint is not
      // a registered Device) reset a device the operator had pinned to 1 straight back to 4 — the
      // "Device concurrency is not fully respected, several agents reach the box at once" report.
      // `undefined` means "this caller has no new policy", not "the policy is the fallback"; a fresh
      // device still starts at MAX_BATCH in `deviceFor`.
      device.concurrency = configuredConcurrency.get(input.deviceKey) ?? input.concurrency ?? device.concurrency
      revokeExcess(device)
      if (input.minRunMs !== undefined) device.minRunMs = input.minRunMs
      if (input.locality !== undefined) device.locality = input.locality
      sweep(device)
      // A raised cap belongs to the device, not to the newcomer that happened to carry it. Give
      // already-waiting sessions first claim through EEVDF before considering another background
      // admission. Foreground is the exception: it owns the next available safe slot.
      if (!isFocused(input.sessionClass)) drain(device)
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
      if (!device.revocations.has(input.sessionID))
        device.revocations.set(input.sessionID, Deferred.makeUnsafe<boolean>())
      if (isFocused(input.sessionClass)) {
        // Maintenance is deliberately interruptible. Continuous batching does not make a long
        // utility prefill free: on the Spark a compaction already in flight delayed a brand-new
        // interactive chat's first token by 150 seconds. Signal every acquired maintenance lease;
        // `runMaintenance` races its provider effect against this signal and aborts the request.
        const preempt = [...device.inFlightMaintenance]
        // The device cap is a HARD capacity fact, not merely a background suggestion. The old
        // foreground bypass admitted one viewed chat on top of an already-full batch. On the
        // 121-GiB Spark's mmap-backed Flash-Next deployment that turned two healthy requests into
        // 1-2 aggregate token/s through PLE page churn. Foreground still wins the NEXT safe
        // boundary, but a non-preemptible batch is allowed to finish instead of oversubscribing the
        // backend it already owns.
        if (inFlight(device) < device.concurrency) {
          device.inFlightInteractive.add(input.sessionID)
          device.lastDispatched = input.sessionID
          device.recent.set(input.sessionID, now())
          for (const maintenanceID of preempt) {
            const preemption = device.maintenancePreemptions.get(maintenanceID)
            if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
          }
          return Effect.void
        }
        // Queue BEFORE signalling maintenance. Completing a preemption may run its release
        // finalizer synchronously; if the foreground waiter is not visible yet, that release hands
        // the freed slot to another maintenance request and creates a priority inversion.
        const waiting = queue(device, input, "interactive")
        for (const maintenanceID of preempt) {
          const preemption = device.maintenancePreemptions.get(maintenanceID)
          if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
        }
        return waiting
      }
      if (!isFocused(input.sessionClass) && batchCapacity(device)) {
        if (kind === "maintenance") device.inFlightMaintenance.add(input.sessionID)
        else device.inFlightBatch.add(input.sessionID)
        device.lastDispatched = input.sessionID
        device.recent.set(input.sessionID, now())
        return Effect.void
      }
      return queue(device, input, kind)
    })

  const admit = (input: AdmitInput): Effect.Effect<void> => admitKind(input, "batch")

  const releaseSlot = (input: ReleaseInput, transferring: boolean): Effect.Effect<void> =>
    Effect.sync(() => {
      const device = devices.get(input.deviceKey)
      if (!device) return
      const held =
        device.inFlightInteractive.delete(input.sessionID) ||
        device.inFlightBatch.delete(input.sessionID) ||
        device.inFlightMaintenance.delete(input.sessionID)
      if (!held) return
      if (!transferring) {
        const revocation = device.revocations.get(input.sessionID)
        if (revocation) Deferred.doneUnsafe(revocation, Effect.succeed(false))
        device.revocations.delete(input.sessionID)
      }
      device.maintenanceOwners.delete(input.sessionID)
      // The session has stopped holding the device: start its block clock, so its debt is kept
      // for the forgiveness window and its entry is swept once that window closes. Gated on
      // `held` because `release` runs twice per turn (in-band, then the `ensuring` net) and the
      // second call must not restart the clock.
      device.ledger.onBlock(input.sessionID, now())
      sweep(device)
      drain(device)
    })

  const release = (input: ReleaseInput) => releaseSlot(input, false)
  const transferRelease = (input: ReleaseInput) => releaseSlot(input, true)

  const awaitRevocation: Interface["awaitRevocation"] = (input) =>
    Effect.suspend(() => {
      const revocation = devices.get(input.deviceKey)?.revocations.get(input.sessionID)
      return revocation === undefined ? Effect.never : Deferred.await(revocation)
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
        ...(input.minRunMs === undefined ? {} : { minRunMs: input.minRunMs }),
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
        device.recent.delete(sessionID)
        device.inFlightInteractive.delete(sessionID)
        device.inFlightBatch.delete(sessionID)
        const revocation = device.revocations.get(sessionID)
        if (revocation) Deferred.doneUnsafe(revocation, Effect.succeed(false))
        device.revocations.delete(sessionID)
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
        // generation capacity forever. Session removal interrupts execution before eviction too.
        for (const [taskID, ownerID] of device.maintenanceOwners) {
          if (ownerID !== sessionID) continue
          const maintenanceWaiter = device.waiters.get(taskID)
          device.maintenanceOwners.delete(taskID)
          const preemption = device.maintenancePreemptions.get(taskID)
          if (preemption) Deferred.doneUnsafe(preemption, Effect.void)
          device.maintenancePreemptions.delete(taskID)
          device.inFlightMaintenance.delete(taskID)
          const taskRevocation = device.revocations.get(taskID)
          if (taskRevocation) Deferred.doneUnsafe(taskRevocation, Effect.succeed(false))
          device.revocations.delete(taskID)
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
        minRunMs: device.minRunMs,
        ...(device.locality === undefined ? {} : { locality: device.locality }),
        inFlightInteractive: [...device.inFlightInteractive],
        inFlightBatch: [...device.inFlightBatch],
        inFlightMaintenance: [...device.inFlightMaintenance],
        waiting: [...device.waiters.keys()],
        waitingMaintenance: [...device.waiters].filter(([, waiter]) => waiter.kind === "maintenance").map(([id]) => id),
        ledger: device.ledger.snapshot(),
      })),
    )

  return {
    admit, release, transferRelease, awaitRevocation, syncDevices,
    refreshDevices: () => Effect.void,
    report, admitMaintenance, awaitMaintenancePreemption, releaseMaintenance, evict, snapshot,
  }
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

export const configuredLayer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const service = make()
    const settings = yield* SettingsConfigStore.Service
    const sync = () => Effect.flatMap(settings.all(), (entries) => service.syncDevices(
      (entries.devices ?? {}) as Readonly<Record<string, { readonly concurrency?: number }>>,
    ))
    yield* sync()
    const { ConfigStoreWrite } = yield* Effect.promise(() => import("../config-store-write"))
    yield* ConfigStoreWrite.registerReload("devices", sync)
    return Service.of({ ...service, refreshDevices: sync })
  }),
)

export const layer = configuredLayer.pipe(Layer.provide(SettingsConfigStore.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
