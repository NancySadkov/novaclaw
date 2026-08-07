import fs from "fs"
import os from "os"
import path from "path"

/**
 * 🔴 **This package's tests had NO isolation at all until 2026-08-07.**
 *
 * `packages/core` and `packages/novaclaw` each pin the instance home in a `bunfig.toml` preload;
 * `packages/server` had neither, so `DatabasePath.path()` resolved the developer's REAL instance
 * database for every test in this unit. Nothing had noticed, because a test that never opens the
 * database looks identical to one that is isolated — the guard in `db-path.ts` is what made the
 * difference visible.
 *
 * ⚠️ **`NOVACLAW_DB` alone is half the isolation** — the lesson `packages/core/test/preload.ts` paid
 * for on 2026-08-05, when the memory graph under `Global.Path.data` pulled the owner's real saved
 * memories into a test's system prompt. `NOVACLAW_HOME` moves config, data, state and cache together
 * (AGENTS.md pitfall #0), so it is set too.
 */
const TEST_HOME_ROOT = path.join(os.tmpdir(), "novaclaw-test-home-server")
process.env.NOVACLAW_DB = ":memory:"
process.env.NOVACLAW_HOME = path.join(TEST_HOME_ROOT, String(process.pid))

/**
 * 🔴 **Reap abandoned homes — PID-scoping WITHOUT a reaper is the documented trap, and the first
 * draft of this file walked straight into it.**
 *
 * `bun test` does not run `process.on("exit")` handlers, so a killed run cleans up nothing: the
 * directories accumulate and, because Windows recycles PIDs, a later run eventually inherits a dead
 * run's home — a previous run's state presented as its own. That shape one directory over left **257
 * abandoned files** and produced a gate failure that read as a content regression.
 * `test/tmpdir-namespace.test.ts` fails on the shape and caught this file, which is exactly what it
 * exists for.
 *
 * Keyed on PID LIVENESS, never on age: units run in their own processes, so an age sweep would delete
 * a concurrent run's home. `process.kill(pid, 0)` is the probe — no throw means alive, `ESRCH` means
 * gone, `EPERM` means alive under another account and is left alone.
 */
try {
  for (const entry of fs.readdirSync(TEST_HOME_ROOT)) {
    const pid = Number(entry)
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue
    try {
      process.kill(pid, 0)
      continue // still running — not ours to delete
    } catch (error) {
      if ((error as { code?: string } | undefined)?.code === "EPERM") continue
    }
    try {
      fs.rmSync(path.join(TEST_HOME_ROOT, entry), { recursive: true, force: true })
    } catch {
      // Another process may be reaping the same home; losing the race is fine.
    }
  }
} catch {
  // The root may not exist yet on a first run — nothing to reap.
}
