export * as DatabasePath from "./db-path"

import { isAbsolute, join } from "path"
import { Flag } from "../flag/flag"
import { Global } from "../global"
import { InstallationChannel } from "../installation/version"

// The instance database file. A LEAF module (no drizzle/migration imports) so boot-time snapshot
// readers — the offline chokepoint reads the settings store SYNCHRONOUSLY at layer init — can
// resolve the same file the Database layer opens without dragging its module graph along.
// Moved verbatim from database.ts (which re-exports it; keep exactly one copy of this logic).
export function path() {
  if (Flag.NOVACLAW_DB) {
    if (Flag.NOVACLAW_DB === ":memory:" || isAbsolute(Flag.NOVACLAW_DB)) return Flag.NOVACLAW_DB
    return join(Global.Path.data, Flag.NOVACLAW_DB)
  }
  if (
    ["latest", "beta", "prod"].includes(InstallationChannel) ||
    process.env.NOVACLAW_DISABLE_CHANNEL_DB === "1" ||
    process.env.NOVACLAW_DISABLE_CHANNEL_DB === "true"
  )
    return join(Global.Path.data, "novaclaw.db")
  return join(Global.Path.data, `novaclaw-${InstallationChannel.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
}
