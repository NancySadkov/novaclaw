import type { ServerConnection } from "@/context/server"
import { instanceFetch } from "@/utils/instance-fetch"

// `GET /scheduler/snapshot` — the live `ps` view over the running session world (the EEVDF ledger's
// own introspection surface).
//
// The scheduler is a per-instance singleton, so `directory` here is only request routing.
//
// ⚠️ Base URL, auth, and fault decoding live in `utils/instance-fetch.ts`. This client used to throw
// a bare `GET scheduler/snapshot failed: <status>`; through the seam it now surfaces the server's
// own message when there is one, which is strictly more than it said before.

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
  return instanceFetch<SchedulerDevice[]>(server, { route: "scheduler/snapshot", directory: input.directory })
}
