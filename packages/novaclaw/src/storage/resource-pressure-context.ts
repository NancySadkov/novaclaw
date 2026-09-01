export * as StorageResourcePressureContext from "./resource-pressure-context"

import { Effect, Layer } from "effect"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { Bytes } from "@novaclaw/core/util/bytes"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Log } from "@novaclaw/schema/log"
import { HostPressure } from "./host-pressure"
import { Pressure } from "./pressure"

export const formatBytes = Bytes.binary

const levelLine = (level: Pressure.Level): string => {
  if (level === "warning") return "Resource pressure: warning — plan memory- and disk-intensive work conservatively."
  if (level === "floor") return "Resource pressure: floor — do not start memory- or disk-intensive work."
  return `Resource pressure: ${level}.`
}

/** Full, point-in-time detail returned only when the model explicitly asks through resource_status. */
export function details(report: Pressure.Report): ReadonlyArray<string> {
  const result = [levelLine(report.level)]
  const accounted = new Set<string>()

  if (report.memory.known) {
    const free = Math.max(0, report.memory.limitBytes - report.memory.usedBytes)
    result.push(`Memory headroom: ${formatBytes(free)} free of ${formatBytes(report.memory.limitBytes)} commit.`)
  } else {
    accounted.add(report.memory.reason)
    result.push(`Memory headroom: unavailable — ${report.memory.reason}`)
  }

  const knownDisks = report.disks.filter((disk): disk is Pressure.DiskKnown => disk.known)
  if (knownDisks.length > 0) {
    const lowest = knownDisks.reduce((worst, disk) => (disk.freeBytes < worst.freeBytes ? disk : worst))
    result.push(
      `Disk headroom: ${formatBytes(lowest.freeBytes)} free of ${formatBytes(lowest.totalBytes)} ` +
        `on the lowest-free instance volume (${lowest.measuredPath}).`,
    )
  } else {
    const reasons = report.disks
      .map((disk) => {
        if (!disk.known) accounted.add(disk.reason)
        return disk.known ? "" : disk.reason
      })
      .filter(Boolean)
    result.push(`Disk headroom: unavailable${reasons.length > 0 ? ` — ${reasons.join(" ")}` : "."}`)
  }

  for (const disk of report.disks) if (!disk.known) accounted.add(disk.reason)
  for (const notice of report.unavailable) {
    if (accounted.has(notice)) continue
    result.push(`Resource pressure notice: ${notice}`)
  }
  return result
}

const urgency = (level: Pressure.Level) => (level === "floor" ? "critically low" : "low")

/** Whole MiB. The model is being asked to make a judgement call, and it needs a number to make it. */
const mib = (bytes: number) => `${Math.round(bytes / Bytes.MIB)} MB`

/**
 * Exception-only ambient context. Healthy and unmeasurable probes say nothing: normal headroom is the
 * default, while measurement diagnostics remain available through resource_status and Instance settings.
 *
 * ⭐ **The memory line carries NUMBERS, not an adjective** (owner, 2026-08-05): *"tell the model exact
 * amount committed / total virtual memory (in mb), and only when the memory is below a specific
 * threshold — since it is a warning, not a monitoring heartbeat side channel distracting the model
 * from the task."* "Memory headroom is low" gives an agent nothing to reason with; it cannot tell
 * whether a 2 GB test run is fine or fatal. `13 900 MB of 45 800 MB committed` it can act on.
 *
 * ⚠️ **The cost of exact figures, and why it is acceptable HERE.** Byte counts move every turn, and a
 * moving system-context line regenerates the durable baseline — which is why these lines were
 * previously kept stable inside a severity band. That cost is bounded by the exception-only rule: the
 * line exists ONLY under warning/floor, so the churn happens only while the machine is already
 * struggling, which is exactly when a stale number would be the more expensive mistake. Do not extend
 * numeric lines to the healthy path without re-opening that trade.
 */
export function lines(report: Pressure.Report): ReadonlyArray<string> {
  const result: string[] = []
  const memoryLevel = Pressure.memoryLevel(report.memory, report.thresholds)
  if (report.memory.known && (memoryLevel === "warning" || memoryLevel === "floor"))
    result.push(
      `Memory headroom is ${urgency(memoryLevel)}: ${mib(report.memory.usedBytes)} of ` +
        `${mib(report.memory.limitBytes)} committed. Avoid memory-intensive work.`,
    )

  const disks = new Map<string, Pressure.Level>()
  for (const disk of report.disks) {
    const diskLevel = Pressure.diskLevel(disk, report.thresholds)
    if (!disk.known || (diskLevel !== "warning" && diskLevel !== "floor")) continue
    const previous = disks.get(disk.measuredPath)
    if (previous !== "floor") disks.set(disk.measuredPath, diskLevel)
  }
  // ⚠️ SORTED by path: `disks` is keyed in probe order, so two runs could emit the same warnings in a
  // different order and re-prefill everything after this block for no change in meaning
  // (NC-PROMPT-CACHE-006).
  for (const [measuredPath, diskLevel] of [...disks].toSorted((a, b) => a[0].localeCompare(b[0])))
    result.push(`Disk space is ${urgency(diskLevel)} on ${measuredPath}; avoid large writes.`)
  if (result.length > 0)
    result.push("Use tool_search for resource status, then resource_status to inspect and confirm recovery.")
  return result
}

/** The exact report fields the capability governor needs; unknown stays unknown and fails closed. */
export function capacity(report: Pressure.Report): ResourcePressureContext.CommitCapacity | undefined {
  if (!report.memory.known) return undefined
  return {
    limitBytes: report.memory.limitBytes,
    usedBytes: report.memory.usedBytes,
    floorUsedFraction: report.thresholds.floor.memoryUsedFraction,
  }
}

export const layer = Layer.effect(
  ResourcePressureContext.Service,
  Effect.gen(function* () {
    const storage = yield* HostPressure.Service
    const measure = storage.pressure()
    return ResourcePressureContext.Service.of({
      lines: () =>
        measure.pipe(
          Effect.map(lines),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Log.fault(cause) }).pipe(
              Effect.as([]),
            ),
          ),
        ),
      inspect: () =>
        measure.pipe(
          Effect.map(details),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Log.fault(cause) }).pipe(
              Effect.as(["Resource headroom is unavailable because the host measurement failed."]),
            ),
          ),
        ),
      capacity: () =>
        measure.pipe(
          Effect.map(capacity),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Log.fault(cause) }).pipe(
              Effect.as(undefined),
            ),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: ResourcePressureContext.Service,
  layer,
  deps: [HostPressure.node],
})
