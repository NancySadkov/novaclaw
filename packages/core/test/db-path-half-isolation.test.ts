import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@novaclaw/core/flag/flag"
import { DatabasePath } from "@novaclaw/core/database/db-path"

/**
 * `NOVACLAW_DB` moves one file and looks like it moves the instance. The warning is the code
 * saying so, once, where the doc and a memory note used to be the only witnesses.
 */
const original = Flag.NOVACLAW_DB
afterEach(() => {
  Flag.NOVACLAW_DB = original
})

describe("the half-isolation warning", () => {
  test("🔴 NOVACLAW_DB alone, with nothing moving the home, is named as half an isolation", () => {
    Flag.NOVACLAW_DB = "C:\\tmp\\probe.db"
    const warning = DatabasePath.halfIsolationWarning({})
    expect(warning).toBeDefined()
    expect(warning).toContain("moves only the database file")
    expect(warning).toContain("NOVACLAW_HOME")
  })

  test("a whole home (NOVACLAW_HOME, or XDG_DATA_HOME) is not warned about", () => {
    Flag.NOVACLAW_DB = "C:\\tmp\\probe.db"
    expect(DatabasePath.halfIsolationWarning({ NOVACLAW_HOME: "C:\\tmp\\home" })).toBeUndefined()
    expect(DatabasePath.halfIsolationWarning({ XDG_DATA_HOME: "C:\\tmp\\data" })).toBeUndefined()
  })

  test("no NOVACLAW_DB, no warning", () => {
    Flag.NOVACLAW_DB = undefined
    expect(DatabasePath.halfIsolationWarning({})).toBeUndefined()
  })
})
