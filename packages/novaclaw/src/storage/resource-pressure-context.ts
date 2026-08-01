export * as StorageResourcePressureContext from "./resource-pressure-context"

import { Cause, Effect, Layer } from "effect"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Log } from "@novaclaw/schema/log"
import { Storage } from "./storage"
import type { Pressure } from "./pressure"

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

/** Render Storage's structured report into the compact, plain-language `<env>` block. */
export function lines(report: Pressure.Report): ReadonlyArray<string> {
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

export const layer = Layer.effect(
  ResourcePressureContext.Service,
  Effect.gen(function* () {
    const storage = yield* Storage.Service
    return ResourcePressureContext.Service.of({
      lines: () =>
        storage.pressure().pipe(
          Effect.map(lines),
          Effect.catchCause((cause) =>
            Log.event("resource.headroom.measure.failed", { "resource.cause": Cause.pretty(cause) }).pipe(
              Effect.as(["Resource headroom: unavailable — the host measurement failed."]),
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
