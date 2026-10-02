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
  /** Admission cap for this device (device profile, else the scheduler default). */
  readonly concurrency?: number
  /** Cache-affinity window in ms; 0 means the EEVDF ledger decides alone. */
  readonly minRunMs: number
  readonly locality?: "local" | "lan" | "remote"
  /** Sessions currently holding an interactive slot on this device. */
  readonly inFlightInteractive: readonly string[]
  /** Sessions currently holding a batch slot (sub-agent, goal, cron classes). */
  readonly inFlightBatch: readonly string[]
  /**
   * Background passes holding a maintenance lease — they cost the provider but not a device slot.
   * Optional so a client built against this shape still reads an older server that omits it.
   */
  readonly inFlightMaintenance?: readonly string[]
  /** Sessions queued for a slot — a non-empty list here is contention, not a bug. */
  readonly waiting: readonly string[]
  readonly waitingMaintenance?: readonly string[]
  readonly ledger: readonly SchedulerLedgerEntry[]
}

export function schedulerSnapshot(server: ServerConnection.HttpBase, input: { directory: string }) {
  return instanceFetch<SchedulerDevice[]>(server, { route: "scheduler/snapshot", directory: input.directory })
}
