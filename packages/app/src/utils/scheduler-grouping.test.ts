import { describe, expect, test } from "bun:test"
import {
  groupSchedulerByModel,
  MAINTENANCE_MODEL,
  UNRESOLVED_MODEL,
  type SchedulerSessionRef,
} from "./scheduler-grouping"
import type { SchedulerDevice, SchedulerLedgerEntry } from "./scheduler-api"

const ledgerEntry = (id: string): SchedulerLedgerEntry => ({
  id,
  weight: 20,
  sliceTokens: 32_000,
  lag: 0,
  vdeadline: 1,
})

const device = (over: Partial<SchedulerDevice> & Pick<SchedulerDevice, "deviceKey">): SchedulerDevice => ({
  deviceKey: over.deviceKey,
  concurrency: over.concurrency ?? 4,
  minRunMs: over.minRunMs ?? 0,
  inFlightInteractive: over.inFlightInteractive ?? [],
  inFlightBatch: over.inFlightBatch ?? [],
  inFlightMaintenance: over.inFlightMaintenance,
  waiting: over.waiting ?? [],
  waitingMaintenance: over.waitingMaintenance,
  ledger: over.ledger ?? [],
})

const ref = (label: string, over: Partial<SchedulerSessionRef> = {}): SchedulerSessionRef => ({
  modelKey: label.toLowerCase().replace(/\s+/g, "-"),
  label,
  ...over,
})

describe("groupSchedulerByModel", () => {
  test("groups sessions of different models under separate keys with their human names", () => {
    const sessions: Record<string, SchedulerSessionRef> = {
      a: ref("Holo 3.1", { modelKey: "spark-holo/holo3.1" }),
      b: ref("Space Bunny", { modelKey: "other/space-bunny-free" }),
      c: ref("Holo 3.1", { modelKey: "spark-holo/holo3.1" }),
    }
    const groups = groupSchedulerByModel(
      [
        device({
          deviceKey: "spark-device",
          inFlightInteractive: ["b"],
          inFlightBatch: ["a"],
          waiting: ["c"],
          ledger: [ledgerEntry("a"), ledgerEntry("b"), ledgerEntry("c")],
        }),
      ],
      (id) => sessions[id],
    )
    const byKey = Object.fromEntries(groups.map((group) => [group.key, group]))
    expect(Object.keys(byKey).sort()).toEqual(["other/space-bunny-free", "spark-holo/holo3.1"])
    // The two sessions of the same model share one group even across states.
    expect(byKey["spark-holo/holo3.1"]!.entries.map((entry) => entry.id)).toEqual(["a", "c"])
    expect(byKey["spark-holo/holo3.1"]!.label).toBe("Holo 3.1")
    expect(byKey["spark-holo/holo3.1"]!.waiting).toEqual(["c"])
    expect(byKey["spark-holo/holo3.1"]!.deviceKeys).toEqual(["spark-device"])
    expect(byKey["spark-holo/holo3.1"]!.counts).toMatchObject({ batch: 1, waiting: 1, recent: 0 })
    expect(byKey["other/space-bunny-free"]!.entries[0]).toMatchObject({ id: "b", state: "interactive" })
    // Equal in flight, so the group with a queued session sorts first.
    expect(groups[0]!.key).toBe("spark-holo/holo3.1")
  })

  test("a session in flight AND in the ledger appears once, with its ledger stats", () => {
    const groups = groupSchedulerByModel(
      [device({ deviceKey: "d", inFlightBatch: ["a"], ledger: [ledgerEntry("a"), ledgerEntry("a")] })],
      () => ref("Model"),
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.entries).toHaveLength(1)
    expect(groups[0]!.entries[0]).toMatchObject({ id: "a", state: "batch", ledger: { weight: 20 } })
    expect(groups[0]!.counts.batch).toBe(1)
    expect(groups[0]!.counts.recent).toBe(0)
  })

  test("an unresolvable session is shown, not dropped", () => {
    const groups = groupSchedulerByModel([device({ deviceKey: "d", waiting: ["ghost"] })], () => undefined)
    expect(groups[0]!.key).toBe(UNRESOLVED_MODEL)
    expect(groups[0]!.waiting).toEqual(["ghost"])
    expect(groups[0]!.label).toBe("Model unknown")
  })

  test("background maintenance passes get their own group, named by task", () => {
    const groups = groupSchedulerByModel(
      [
        device({
          deviceKey: "d",
          inFlightMaintenance: ["maintenance:7:title:ses_owner"],
          waitingMaintenance: ["maintenance:8:compact:ses_owner"],
        }),
      ],
      () => undefined,
    )
    const maintenance = groups.find((group) => group.key === MAINTENANCE_MODEL)!
    expect(maintenance).toBeDefined()
    expect(maintenance.entries.map((entry) => entry.state)).toEqual(["maintenance", "waiting-maintenance"])
    expect(maintenance.entries[0]!.session?.title).toContain("title")
    expect(maintenance.inFlight).toBe(1)
    // A waiting maintenance pass is not counted as an ordinary waiting session.
    expect(maintenance.waiting).toEqual([])
  })

  test("an older server that omits maintenance and concurrency still reads", () => {
    const legacy: SchedulerDevice = {
      deviceKey: "d",
      minRunMs: 0,
      inFlightInteractive: ["a"],
      inFlightBatch: [],
      waiting: [],
      ledger: [],
    }
    const groups = groupSchedulerByModel([legacy], () => ref("Model"))
    expect(groups[0]!.entries.map((entry) => entry.id)).toEqual(["a"])
    expect(groups[0]!.counts["waiting-maintenance"]).toBe(0)
  })
})
