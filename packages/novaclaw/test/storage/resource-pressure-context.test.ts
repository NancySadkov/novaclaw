import { describe, expect, test } from "bun:test"
import { Logging } from "@novaclaw/core/observability/logging"
import { ResourcePressureContext } from "@novaclaw/core/resource-pressure-context"
import { Effect, Layer, Logger, References } from "effect"
import { Pressure } from "@/storage/pressure"
import { StorageResourcePressureContext } from "@/storage/resource-pressure-context"
import { HostPressure } from "@/storage/host-pressure"

const GIB = 1024 ** 3
const thresholds: Pressure.Thresholds = Pressure.DEFAULT_THRESHOLDS

describe("StorageResourcePressureContext", () => {
  test("exposes healthy measurements on demand and to mechanical admission", () => {
    const report: Pressure.Report = {
      memory: {
        known: true,
        source: "windows-commit",
        crosscheck: "Get-CimInstance Win32_OperatingSystem",
        usedBytes: 10 * GIB,
        limitBytes: 40 * GIB,
      },
      disks: [{ known: true, path: "C:/data", measuredPath: "C:/", freeBytes: 50 * GIB, totalBytes: 100 * GIB }],
      thresholds,
      thresholdsSource: "default",
      level: "ok",
      unavailable: [],
    }

    expect(StorageResourcePressureContext.capacity(report)).toEqual({
      limitBytes: 40 * GIB,
      usedBytes: 10 * GIB,
      floorUsedFraction: thresholds.floor.memoryUsedFraction,
    })
    expect(StorageResourcePressureContext.details(report)).toEqual([
      "Resource pressure: ok.",
      "Memory headroom: 30.0 GiB free of 40.0 GiB commit.",
      "Disk headroom: 50.0 GiB free of 100.0 GiB on the lowest-free instance volume (C:/).",
    ])
  })

  test("on-demand detail names the resources that are low", () => {
    // 34 of 40 GiB committed = 85% used AND only 6 GiB free — low by BOTH memory gates. The fixture
    // used to sit at 30/40 (75%, 10 GiB free), which is precisely the healthy-box false positive the
    // 2026-08-13 incident removed: the fraction crossed while absolute room remained plentiful.
    const report: Pressure.Report = {
      memory: {
        known: true,
        source: "windows-commit",
        crosscheck: "Get-CimInstance Win32_OperatingSystem",
        usedBytes: 34 * GIB,
        limitBytes: 40 * GIB,
      },
      disks: [
        { known: true, path: "C:/data", measuredPath: "C:/", freeBytes: 50 * GIB, totalBytes: 100 * GIB },
        { known: true, path: "D:/cache", measuredPath: "D:/", freeBytes: 5 * GIB, totalBytes: 20 * GIB },
      ],
      thresholds,
      thresholdsSource: "default",
      level: "warning",
      unavailable: [],
    }

    expect(StorageResourcePressureContext.details(report)).toEqual([
      "Resource pressure: warning — plan memory- and disk-intensive work conservatively.",
      "Memory headroom: 6.0 GiB free of 40.0 GiB commit.",
      "Disk headroom: 5.0 GiB free of 20.0 GiB on the lowest-free instance volume (D:/).",
    ])
  })

  test("names unknown probes and a rejected threshold setting without inventing zero", () => {
    const memoryReason = "Memory headroom is unavailable: no commit probe."
    const diskReason = "Disk headroom for /data is unavailable: no statfs."
    const configNotice =
      "The stored `resource_pressure` setting could not be read, so the shipped default thresholds are in force."
    const report: Pressure.Report = {
      memory: { known: false, reason: memoryReason },
      disks: [{ known: false, path: "/data", reason: diskReason }],
      thresholds,
      thresholdsSource: "invalid",
      level: "unknown",
      unavailable: [memoryReason, diskReason, configNotice],
    }

    expect(StorageResourcePressureContext.capacity(report)).toBeUndefined()
    const rendered = StorageResourcePressureContext.details(report)
    expect(rendered).toEqual([
      "Resource pressure: unknown.",
      `Memory headroom: unavailable — ${memoryReason}`,
      `Disk headroom: unavailable — ${diskReason}`,
      `Resource pressure notice: ${configNotice}`,
    ])
    expect(rendered.join("\n")).not.toContain("0 bytes")
  })

  test("measurement defects degrade and emit one keyed, local-only fault", async () => {
    const logLines: string[] = []
    const capture = Logger.map(Logging.formatter("resource-test"), (line) => logLines.push(line))
    const rendered = await Effect.runPromise(
      Effect.gen(function* () {
        const context = yield* ResourcePressureContext.Service
        return yield* context.level()
      }).pipe(
        Effect.provide(StorageResourcePressureContext.layer),
        Effect.provide(Layer.mock(HostPressure.Service, { pressure: () => Effect.die("probe exploded") })),
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    )

    expect(rendered).toBe("unknown")
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain("level=WARN")
    expect(logLines[0]).toContain("event=resource.headroom.measure.failed")
    expect(logLines[0]).toContain("resource.cause=")
    expect(logLines[0]).toContain("probe exploded")
  })
})
