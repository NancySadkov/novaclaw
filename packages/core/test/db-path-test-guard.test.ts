import { describe, expect, test } from "bun:test"
import { DatabasePath } from "../src/database/db-path"
import { Flag } from "../src/flag/flag"

/**
 * 🔴 Ruling 1 for the test-isolation write guard.
 *
 * `test/preload.ts` pins `NOVACLAW_DB=":memory:"`, but it is resolved through the app package's
 * `bunfig.toml` — so an invocation that misses it runs the suite against the owner's live data.
 * `bun test` sets `NODE_ENV=test` itself, which is why that is the signal: it survives the very
 * failure it has to catch.
 *
 * ⚠️ **This is not hypothetical.** The owner's store still holds `username: "patched-user"`
 * (2026-07-21) and seven `agent-N {hidden:true}` fixture agents (2026-07-31), beside a real
 * `user_profile`. On 2026-08-07 a failed `cd` nearly did it again; the fixture's `resetDatabase()`
 * guard refused, but that covers a RESET only — a test that merely reads or writes sails past it.
 */
const withFlag = (value: string | undefined, run: () => void) => {
  const original = Flag.NOVACLAW_DB
  Flag.NOVACLAW_DB = value
  try {
    run()
  } finally {
    Flag.NOVACLAW_DB = original
  }
}

describe("the real database is unreachable from a test run", () => {
  test("🔴 refuses the default path when NODE_ENV=test and nothing was pinned", () => {
    // The exact accident: preload never ran, so no flag is set, and the resolver would otherwise
    // return the owner's `novaclaw-*.db`.
    expect(process.env.NODE_ENV).toBe("test")
    withFlag(undefined, () => {
      expect(() => DatabasePath.path()).toThrow(/Refusing to open the real instance database/)
    })
  })

  test("the refusal names the cause and the fix, not just the symptom", () => {
    // Ruling 2: whoever hits this is usually in the wrong directory and will not guess that from
    // "database error". The message has to say what happened and what to do.
    withFlag(undefined, () => {
      const message = (() => {
        try {
          DatabasePath.path()
          return ""
        } catch (error) {
          return error instanceof Error ? error.message : String(error)
        }
      })()
      expect(message).toContain("NODE_ENV=test")
      expect(message).toContain("preload")
      expect(message).toContain("NOVACLAW_DB")
      expect(message).toContain("wrong")
    })
  })

  test("an EXPLICIT database is still allowed — stating intent is the escape hatch", () => {
    // The probes under `tests/` deliberately use a file so rows outlive the server. Refusing those
    // would push people back to unguarded workarounds, which is worse than the hole.
    withFlag(":memory:", () => expect(DatabasePath.path()).toBe(":memory:"))
    const explicit = process.platform === "win32" ? "C:\\tmp\\probe.db" : "/tmp/probe.db"
    withFlag(explicit, () => expect(DatabasePath.path()).toBe(explicit))
  })
})
