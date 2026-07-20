import type { ServerConnection } from "@/context/server"
import { authTokenFromCredentials } from "@/utils/server"

// Raw-fetch helper for `GET /scheduler/snapshot` — the live `ps` view over the running session world
// (the EEVDF ledger's own introspection surface). NOT in the generated SDK (golden rule: never
// hand-edit packages/sdk/**/gen/**) — plain fetch with the createSdkForServer auth recipe, exactly like
// registry-api.ts / memory-api.ts.
//
// The scheduler is a per-instance singleton, so `directory` here is only request routing.

export interface SchedulerLedgerEntry {
  readonly id: string
  readonly weight: number
  readonly sliceTokens: number
  readonly lag: number
  readonly vdeadline: number
}

export interface SchedulerDevice {
  readonly deviceKey: string
  /** Sessions currently holding an interactive slot on this device. */
  readonly inFlightInteractive: readonly string[]
  /** Sessions currently holding a batch slot (sub-agent, auto-prompting, goal, cron classes). */
  readonly inFlightBatch: readonly string[]
  /** Sessions queued for a slot — a non-empty list here is contention, not a bug. */
  readonly waiting: readonly string[]
  readonly ledger: readonly SchedulerLedgerEntry[]
}

export function schedulerSnapshot(server: ServerConnection.HttpBase, input: { directory: string }) {
  const url = new URL("scheduler/snapshot", server.url.endsWith("/") ? server.url : `${server.url}/`)
  url.searchParams.set("directory", input.directory)
  return fetch(url, {
    headers: {
      "content-type": "application/json",
      ...(server.password
        ? { Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}` }
        : {}),
    },
  }).then(async (res) => {
    if (!res.ok) throw new Error(`GET scheduler/snapshot failed: ${res.status}`)
    return (await res.json()) as SchedulerDevice[]
  })
}
