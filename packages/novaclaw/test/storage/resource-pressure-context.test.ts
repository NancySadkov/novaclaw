import { describe, expect, test } from "bun:test"
import { Pressure } from "@/storage/pressure"
import { StorageResourcePressureContext } from "@/storage/resource-pressure-context"

const GIB = 1024 ** 3
const thresholds: Pressure.Thresholds = Pressure.DEFAULT_THRESHOLDS

describe("StorageResourcePressureContext", () => {
  test("renders actionable memory and lowest-volume disk headroom", () => {
    const report: Pressure.Report = {
      memory: {
        known: true,
        source: "windows-commit",
        crosscheck: "Get-CimInstance Win32_OperatingSystem",
        usedBytes: 30 * GIB,
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
      "Resource pressure: warning — plan memory- and disk-intensive work conservatively.",
      "Memory headroom: 10.0 GiB free of 40.0 GiB commit.",
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

    const rendered = StorageResourcePressureContext.lines(report)
    expect(rendered).toEqual([
      "Resource pressure: unknown.",
      `Memory headroom: unavailable — ${memoryReason}`,
      `Disk headroom: unavailable — ${diskReason}`,
      `Resource pressure notice: ${configNotice}`,
    ])
    expect(rendered.join("\n")).not.toContain("0 bytes")
  })
})
