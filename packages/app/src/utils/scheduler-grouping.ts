// Grouping the live scheduler snapshot by MODEL.
//
// A device key is an ingress — an API provider — and one provider can serve several models. The
// EEVDF state itself is per device, so the raw snapshot answers "who is on this box" but never
// "which model is packing onto it". An operator asking why a turn is slow is asking the second
// question, so the Debug app joins each queued session to the model it resolved to and groups by
// that. This module is pure so the join is unit-tested rather than only rendered.

import type { SchedulerDevice, SchedulerLedgerEntry } from "./scheduler-api"

export type SchedulerEntryState = "interactive" | "batch" | "maintenance" | "waiting" | "recent"

export interface SchedulerModelEntry {
  readonly id: string
  readonly state: SchedulerEntryState
  readonly deviceKey: string
  readonly ledger: SchedulerLedgerEntry | undefined
}

export interface SchedulerModelGroup {
  readonly key: string
  readonly deviceKeys: readonly string[]
  readonly concurrency: number
  readonly entries: readonly SchedulerModelEntry[]
  readonly waiting: readonly string[]
}

/** A queued session the roster cannot resolve — an inherited model, or one that already ended. */
export const UNRESOLVED_MODEL = "unresolved — inherit or ended"

/**
 * Fold a per-device snapshot into per-model groups.
 *
 * `modelLabel` resolves a session id to `providerID/modelID`; an undefined answer is reported as
 * `UNRESOLVED_MODEL` rather than dropped, because a session that is running but has no model label
 * is itself a fact worth seeing. Each session appears once, in the first state that names it
 * (interactive → batch → maintenance → waiting → recent), so the ledger's memory of a finished
 * turn never duplicates a live entry.
 *
 * `inFlightMaintenance` and `concurrency` are optional: a client built against this shape must
 * still read an older server that omits them.
 */
export const groupSchedulerByModel = (
  devices: readonly SchedulerDevice[],
  modelLabel: (sessionID: string) => string | undefined,
): readonly SchedulerModelGroup[] => {
  const groups = new Map<
    string,
    {
      deviceKeys: Set<string>
      concurrency: number
      entries: SchedulerModelEntry[]
      waiting: string[]
    }
  >()
  for (const device of devices) {
    const ledgerByID = new Map(device.ledger.map((entry) => [entry.id, entry]))
    const seen = new Set<string>()
    const push = (id: string, state: SchedulerEntryState) => {
      if (seen.has(id)) return
      seen.add(id)
      const key = modelLabel(id) ?? UNRESOLVED_MODEL
      const group = groups.get(key) ?? {
        deviceKeys: new Set<string>(),
        concurrency: device.concurrency ?? 0,
        entries: [],
        waiting: [],
      }
      groups.set(key, group)
      group.deviceKeys.add(device.deviceKey)
      group.entries.push({ id, state, deviceKey: device.deviceKey, ledger: ledgerByID.get(id) })
    }
    for (const id of device.inFlightInteractive) push(id, "interactive")
    for (const id of device.inFlightBatch) push(id, "batch")
    for (const id of device.inFlightMaintenance ?? []) push(id, "maintenance")
    for (const id of device.waiting) {
      push(id, "waiting")
      groups.get(modelLabel(id) ?? UNRESOLVED_MODEL)?.waiting.push(id)
    }
    // The ledger remembers recently-finished turns; they still explain why a device looks hot.
    for (const entry of device.ledger) push(entry.id, "recent")
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    deviceKeys: [...group.deviceKeys],
    concurrency: group.concurrency,
    entries: group.entries,
    waiting: group.waiting,
  }))
}
