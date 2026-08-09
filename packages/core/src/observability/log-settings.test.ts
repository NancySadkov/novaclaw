import { afterEach, describe, expect, test } from "bun:test"
import type { Logger, LogLevel } from "effect"
import { LogSettings } from "./log-settings"

const originalLevel = process.env.NOVACLAW_LOG_LEVEL

afterEach(() => {
  LogSettings.apply(undefined)
  if (originalLevel === undefined) delete process.env.NOVACLAW_LOG_LEVEL
  else process.env.NOVACLAW_LOG_LEVEL = originalLevel
})

const options = (logLevel: LogLevel.LogLevel, event?: string) =>
  ({ logLevel, message: event ? [{ event }] : ["plain"] }) as Logger.Options<unknown>

describe("live log settings", () => {
  test("a global level change takes effect without rebuilding the logger", () => {
    const debug = options("Debug")
    expect(LogSettings.allows(debug)).toBe(false)

    LogSettings.apply({ level: "debug" })
    expect(LogSettings.allows(debug)).toBe(true)

    LogSettings.apply({ level: "warn" })
    expect(LogSettings.allows(options("Info"))).toBe(false)
    expect(LogSettings.allows(options("Warn"))).toBe(true)
  })

  test("a declared subsystem override wins only for that keyed subsystem", () => {
    LogSettings.apply({ level: "warn", subsystems: { mcp: "debug" } })

    expect(LogSettings.allows(options("Debug", "mcp.server.spawn.ok"))).toBe(true)
    expect(LogSettings.allows(options("Debug", "filesystem.watcher.start"))).toBe(false)
    expect(LogSettings.allows(options("Debug"))).toBe(false)
  })

  test("retention is a live day projection and removal restores the compiled default", () => {
    const day = 24 * 60 * 60 * 1000
    LogSettings.apply({ retention_days: 7 })
    expect(LogSettings.maxAgeMs()).toBe(7 * day)

    LogSettings.apply(undefined)
    expect(LogSettings.maxAgeMs()).toBe(30 * day)
  })

  test("the environment remains the fallback until the instance store overrides it", () => {
    process.env.NOVACLAW_LOG_LEVEL = "ERROR"
    expect(LogSettings.level()).toBe("error")
    LogSettings.apply({ level: "info" })
    expect(LogSettings.level()).toBe("info")
  })
})
