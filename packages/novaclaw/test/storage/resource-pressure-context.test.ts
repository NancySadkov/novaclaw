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
  test("keeps healthy measurements out of ambient context and exposes them on demand", () => {
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

    expect(StorageResourcePressureContext.lines(report)).toEqual([])
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

  test("ambient context names only the resource that is actually low", () => {
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

    expect(StorageResourcePressureContext.lines(report)).toEqual([
      // ⭐ NUMBERS, not an adjective (owner, 2026-08-05). "Memory headroom is low" gives an agent
      // nothing to reason with — it cannot tell whether a 2 GB test run is fine or fatal. The exact
      // committed/total figures let it decide. Exception-only, so this line is absent on a healthy
      // machine and the churn from moving byte counts is confined to the pressured case.
      "Memory headroom is low: 34816 MB of 40960 MB committed. Avoid memory-intensive work.",
      "Use tool_search for resource status, then resource_status to inspect and confirm recovery.",
    ])
    // 🔴 **This assertion previously required the OPPOSITE and is superseded deliberately.** It pinned
    // "same severity band ⇒ identical line", so that fluctuating byte counts could not regenerate the
    // system context every turn. The owner's 2026-08-05 directive replaces the adjective with exact
    // committed/total figures, which necessarily moves the line whenever memory moves.
    // ⚠️ The old concern is real and is now bounded rather than ignored: the line exists ONLY under
    // warning/floor, so regeneration happens while the machine is already struggling — precisely when a
    // stale number is the more expensive mistake. Do NOT put numbers on the healthy path without
    // re-opening that trade.
    expect(
      StorageResourcePressureContext.lines({
        ...report,
        memory: { ...(report.memory as Pressure.MemoryKnown), usedBytes: 35 * GIB },
      }),
    ).toEqual([
      "Memory headroom is low: 35840 MB of 40960 MB committed. Avoid memory-intensive work.",
      "Use tool_search for resource status, then resource_status to inspect and confirm recovery.",
    ])
    expect(StorageResourcePressureContext.details(report)).toEqual([
      "Resource pressure: warning — plan memory- and disk-intensive work conservatively.",
      "Memory headroom: 6.0 GiB free of 40.0 GiB commit.",
      "Disk headroom: 5.0 GiB free of 20.0 GiB on the lowest-free instance volume (D:/).",
    ])
  })

  test("a low disk emits one stable exception line without normal memory detail", () => {
    const report: Pressure.Report = {
      memory: {
        known: true,
        source: "windows-commit",
        crosscheck: "Get-CimInstance Win32_OperatingSystem",
        usedBytes: 10 * GIB,
        limitBytes: 40 * GIB,
      },
      disks: [
        { known: true, path: "C:/data", measuredPath: "C:/", freeBytes: 1 * GIB, totalBytes: 100 * GIB },
        { known: true, path: "C:/cache", measuredPath: "C:/", freeBytes: 900 * 1024 ** 2, totalBytes: 100 * GIB },
      ],
      thresholds,
      thresholdsSource: "default",
      level: "warning",
      unavailable: [],
    }

    expect(StorageResourcePressureContext.lines(report)).toEqual([
      "Disk space is low on C:/; avoid large writes.",
      "Use tool_search for resource status, then resource_status to inspect and confirm recovery.",
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

    expect(StorageResourcePressureContext.lines(report)).toEqual([])
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
        return yield* context.lines()
      }).pipe(
        Effect.provide(StorageResourcePressureContext.layer),
        Effect.provide(Layer.mock(HostPressure.Service, { pressure: () => Effect.die("probe exploded") })),
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false })),
        Effect.provideService(References.MinimumLogLevel, "Info"),
      ),
    )

    expect(rendered).toEqual([])
    expect(logLines).toHaveLength(1)
    expect(logLines[0]).toContain("level=WARN")
    expect(logLines[0]).toContain("event=resource.headroom.measure.failed")
    expect(logLines[0]).toContain("resource.cause=")
    expect(logLines[0]).toContain("probe exploded")
  })
})
