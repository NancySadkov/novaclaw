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
      level: () =>
        measure.pipe(
          Effect.map((report) => report.level),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Log.fault(cause) }).pipe(
              Effect.as("unknown" as const),
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
