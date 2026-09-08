import { describe, expect, test } from "bun:test"
import { Exit, Schema } from "effect"
import { ConfigLog } from "./log"

const decode = Schema.decodeUnknownExit(ConfigLog.Info, { errors: "all", onExcessProperty: "error" })

describe("log config", () => {
  test("accepts bounded retention and declared subsystem levels", () => {
    expect(Exit.isSuccess(decode({ level: "warn", retention_days: 90, subsystems: { mcp: "debug" } }))).toBe(true)
  })

  test("rejects invalid levels, retention bounds, and undeclared subsystems", () => {
    expect(Exit.isFailure(decode({ level: "trace" }))).toBe(true)
    expect(Exit.isFailure(decode({ retention_days: 0 }))).toBe(true)
    expect(Exit.isFailure(decode({ retention_days: 366 }))).toBe(true)
    expect(Exit.isFailure(decode({ subsystems: { monkey: "debug" } }))).toBe(true)
  })
})
