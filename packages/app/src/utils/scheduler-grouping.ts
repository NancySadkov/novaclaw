// Grouping the live scheduler snapshot by MODEL, for a person to read.
//
// The scheduler's own key is a DEVICE — an endpoint origin, or a declared device id that regroups
// several origins — because that is what shares hardware. An operator asking "which model is loading
// this box" is not asking the device question, and an endpoint id reads to a human as an API
// provider, which is the wrong noun. So a session is joined to the model it resolved to and the rows
// are folded by that; the device each session sits on stays visible as a badge.
//
// The join is a callback rather than an import so this module stays pure: the caller owns the
// session roster and the catalog that names a model. Everything here is unit-tested.

import type { SchedulerDevice, SchedulerLedgerEntry } from "./scheduler-api"

export type SchedulerEntryState = "interactive" | "batch" | "maintenance" | "waiting" | "waiting-maintenance" | "recent"

/** Most-live first: an in-flight turn outranks a queued one, and the ledger's memory comes last. */
export const ENTRY_STATE_ORDER: Readonly<Record<SchedulerEntryState, number>> = {
  interactive: 0,
  batch: 1,
  maintenance: 2,
  waiting: 3,
  "waiting-maintenance": 4,
  recent: 5,
}

/** Synthetic key for background passes (summaries, titles, nudges) that belong to no session. */
export const MAINTENANCE_MODEL = "maintenance"
export const MAINTENANCE_LABEL = "Background maintenance"

/** Key for a queued session whose record pins no model — it resolves one each turn. */
export const INHERITED_MODEL = "inherited"
export const INHERITED_MODEL_LABEL = "Inherited model"

/** Key for a queued session the roster cannot name at all — already ended, or never cached. */
export const UNRESOLVED_MODEL = "unresolved"
export const UNRESOLVED_MODEL_LABEL = "Model unknown"

export interface SchedulerSessionRef {
  /** `providerID/modelID`, or one of the two synthetic keys above. */
  readonly modelKey: string
  /** The human name to show — the model's catalog name, never the raw key. */
  readonly label: string
  readonly title?: string
  readonly agent?: string
  readonly href?: string
}

export interface SchedulerModelEntry {
  readonly id: string
  readonly state: SchedulerEntryState
  readonly deviceKey: string
  readonly ledger: SchedulerLedgerEntry | undefined
  readonly session: SchedulerSessionRef | undefined
}

export interface SchedulerModelGroup {
  readonly key: string
  readonly label: string
  readonly entries: readonly SchedulerModelEntry[]
  readonly deviceKeys: readonly string[]
  /** Sessions queued for a slot, in arrival order. */
  readonly waiting: readonly string[]
  /** Interactive + batch + maintenance passes currently holding a slot. */
  readonly inFlight: number
  readonly counts: Readonly<Record<SchedulerEntryState, number>>
}

const emptyCounts = (): Record<SchedulerEntryState, number> => ({
  interactive: 0,
  batch: 0,
  maintenance: 0,
  waiting: 0,
  "waiting-maintenance": 0,
  recent: 0,
})

/** Background maintenance task ids carry their own discriminator — see `admitMaintenance`. */
const maintenanceLabel = (id: string): string => {
  if (!id.startsWith("maintenance:")) return MAINTENANCE_LABEL
  const task = id.split(":")[2]
  return task === undefined || task === "" ? MAINTENANCE_LABEL : `Background maintenance · ${task}`
}

/**
 * Fold a per-device snapshot into per-MODEL groups.
 *
 * `resolve` answers a model for a session id; a maintenance task is recognised by its id shape and
 * grouped on its own, and anything else the roster cannot name is shown as `UNRESOLVED_MODEL` rather
 * than dropped — a running session with no model label is itself a fact worth seeing. Each session
 * appears once, in the first state that names it (interactive → batch → maintenance → waiting →
 * waiting-maintenance → recent), so the ledger's memory of a finished turn never duplicates a live
 * entry.
 */
export const groupSchedulerByModel = (
  devices: readonly SchedulerDevice[],
  resolve: (sessionID: string) => SchedulerSessionRef | undefined,
): readonly SchedulerModelGroup[] => {
  const groups = new Map<
    string,
    {
      label: string
      deviceKeys: Set<string>
      entries: SchedulerModelEntry[]
      waiting: string[]
      inFlight: number
      counts: Record<SchedulerEntryState, number>
    }
  >()

  const sessionFor = (id: string): SchedulerSessionRef | undefined => {
    if (id.startsWith("maintenance:")) {
      return { modelKey: MAINTENANCE_MODEL, label: MAINTENANCE_LABEL, title: maintenanceLabel(id) }
    }
    return resolve(id)
  }

  for (const device of devices) {
    const ledgerByID = new Map(device.ledger.map((entry) => [entry.id, entry]))
    const seen = new Set<string>()
    const push = (id: string, state: SchedulerEntryState) => {
      if (seen.has(id)) return
      seen.add(id)
      const session = sessionFor(id)
      const key = session?.modelKey ?? UNRESOLVED_MODEL
      const group = groups.get(key) ?? {
        label: session?.label ?? UNRESOLVED_MODEL_LABEL,
        deviceKeys: new Set<string>(),
        entries: [],
        waiting: [],
        inFlight: 0,
        counts: emptyCounts(),
      }
      groups.set(key, group)
      group.deviceKeys.add(device.deviceKey)
      group.counts[state] += 1
      if (state === "waiting") group.waiting.push(id)
      if (state === "interactive" || state === "batch" || state === "maintenance") group.inFlight += 1
      group.entries.push({ id, state, deviceKey: device.deviceKey, ledger: ledgerByID.get(id), session })
    }

    for (const id of device.inFlightInteractive) push(id, "interactive")
    for (const id of device.inFlightBatch) push(id, "batch")
    for (const id of device.inFlightMaintenance ?? []) push(id, "maintenance")
    for (const id of device.waiting) push(id, "waiting")
    for (const id of device.waitingMaintenance ?? []) push(id, "waiting-maintenance")
    // The ledger remembers recently-finished turns; they still explain why a device looks hot.
    for (const entry of device.ledger) push(entry.id, "recent")
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      label: group.label,
      deviceKeys: [...group.deviceKeys],
      entries: [...group.entries].sort(
        (a, b) => ENTRY_STATE_ORDER[a.state] - ENTRY_STATE_ORDER[b.state] || a.id.localeCompare(b.id),
      ),
      waiting: group.waiting,
      inFlight: group.inFlight,
      counts: group.counts,
    }))
    .sort((a, b) => {
      if (a.inFlight !== b.inFlight) return b.inFlight - a.inFlight
      if (a.waiting.length !== b.waiting.length) return b.waiting.length - a.waiting.length
      if (b.counts.recent !== a.counts.recent) return b.counts.recent - a.counts.recent
      return a.label.localeCompare(b.label)
    })
}
