export * as DatabasePath from "./db-path"

import { isAbsolute, join } from "path"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { InstallationChannel } from "../installation/version"

// The instance database file. A LEAF module (no drizzle/migration imports) so boot-time snapshot
// readers — the offline chokepoint reads the settings store SYNCHRONOUSLY at layer init — can
// resolve the same file the Database layer opens without dragging its module graph along.
// Moved verbatim from database.ts (which re-exports it; keep exactly one copy of this logic).
/**
 * 🔴 **A test run may never fall back to the REAL instance database.**
 *
 * `bun test` sets `NODE_ENV=test` itself, which is the point: `test/preload.ts` pins
 * `NOVACLAW_DB=":memory:"`, but it is resolved through the app package's `bunfig.toml`, so any
 * invocation that misses it — a `cd` that silently failed, a runner started from the wrong root —
 * runs the suite against the owner's live data with nothing objecting.
 *
 * ⚠️ **That is not hypothetical. It has happened at least twice**, and the evidence is still in the
 * owner's store: `username: "patched-user"` (2026-07-21) and seven `agent-N {hidden:true}` fixture
 * agents (2026-07-31), sitting beside a real `user_profile`. On 2026-08-07 it nearly happened again;
 * the fixture's `resetDatabase()` guard refused, but that guard only covers a RESET — a test that
 * merely reads or writes sails past it. This closes the write half, at the one place every reader
 * goes through.
 *
 * An explicit `NOVACLAW_DB` still wins, because a test that deliberately wants a file (the probes in
 * `tests/*.ts` do) is stating its intent. What is refused is the silent DEFAULT.
 */
const refuseRealDatabaseUnderTest = () => {
  if (process.env.NODE_ENV !== "test") return
  throw new Error(
    "Refusing to open the real instance database from a test run. NODE_ENV=test and no NOVACLAW_DB " +
      "was set, which means test/preload.ts did not load — usually a runner started from the wrong " +
      "directory. Set NOVACLAW_DB=:memory: (or an explicit file) if this run genuinely needs one. " +
      "Test fixtures have twice been written into the owner's real store this way.",
  )
}

export function path() {
  if (Flag.NOVACLAW_DB) {
    if (Flag.NOVACLAW_DB === ":memory:" || isAbsolute(Flag.NOVACLAW_DB)) return Flag.NOVACLAW_DB
    return join(Global.Path.data, Flag.NOVACLAW_DB)
  }
  refuseRealDatabaseUnderTest()
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.NOVACLAW_DISABLE_CHANNEL_DB === "1" ||
    process.env.NOVACLAW_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "novaclaw.db")
  return join(Global.Path.data, `novaclaw-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}
