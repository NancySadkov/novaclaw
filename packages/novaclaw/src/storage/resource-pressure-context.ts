export * as StorageResourcePressureContext from "./resource-pressure-context"

import { Cause, Effect, Layer } from "effect"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Log } from "@novaclaw/schema/log"
import { Storage } from "./storage"
import { Pressure } from "./pressure"

const GIB = 1024 ** 3
const MIB = 1024 ** 2

export function formatBytes(value: number): string {
  if (value >= GIB) return `${(value / GIB).toFixed(1)} GiB`
  return `${(value / MIB).toFixed(value >= 10 * MIB ? 0 : 1)} MiB`
}

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

/**
 * Exception-only ambient context. Healthy and unmeasurable probes say nothing: normal headroom is the
 * default, while measurement diagnostics remain available through resource_status and Instance settings.
 * Lines are deliberately stable inside a severity band so fluctuating byte counts do not regenerate the
 * system environment every turn.
 */
export function lines(report: Pressure.Report): ReadonlyArray<string> {
  const result: string[] = []
  const memoryLevel = Pressure.memoryLevel(report.memory, report.thresholds)
  if (report.memory.known && (memoryLevel === "warning" || memoryLevel === "floor"))
    result.push(`Memory headroom is ${urgency(memoryLevel)}; avoid memory-intensive work.`)

  const disks = new Map<string, Pressure.Level>()
  for (const disk of report.disks) {
    const diskLevel = Pressure.diskLevel(disk, report.thresholds)
    if (!disk.known || (diskLevel !== "warning" && diskLevel !== "floor")) continue
    const previous = disks.get(disk.measuredPath)
    if (previous !== "floor") disks.set(disk.measuredPath, diskLevel)
  }
  for (const [measuredPath, diskLevel] of disks)
    result.push(`Disk space is ${urgency(diskLevel)} on ${measuredPath}; avoid large writes.`)
  if (result.length > 0)
    result.push("Use tool_search for resource status, then resource_status to inspect and confirm recovery.")
  return result
}

export const layer = Layer.effect(
  ResourcePressureContext.Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    const measure = storage.pressure()
    return ResourcePressureContext.Service.of({
      lines: () =>
        measure.pipe(
          Effect.map(lines),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Cause.pretty(cause) }).pipe(
              Effect.as([]),
            ),
          ),
        ),
      inspect: () =>
        measure.pipe(
          Effect.map(details),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Cause.pretty(cause) }).pipe(
              Effect.as(["Resource headroom is unavailable because the host measurement failed."]),
            ),
          ),
        ),
    })
  }),
)

export const node = makeGlobalNode({
  service: ResourcePressureContext.Service,
  layer,
  deps: [Storage.node],
})
