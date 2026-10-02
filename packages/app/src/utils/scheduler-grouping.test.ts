import { describe, expect, test } from "bun:test"
import { groupSchedulerByModel, UNRESOLVED_MODEL } from "./scheduler-grouping"
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

describe("groupSchedulerByModel", () => {
  test("groups sessions of different models under separate keys, not by device", () => {
    const model: Record<string, string> = {
      a: "spark/qwen3.8-flash-next",
      b: "other/space-bunny-free",
      c: "spark/qwen3.8-flash-next",
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
      (id) => model[id],
    )
    const byKey = Object.fromEntries(groups.map((group) => [group.key, group]))
    expect(Object.keys(byKey).sort()).toEqual(["other/space-bunny-free", "spark/qwen3.8-flash-next"])
    // The two sessions of the same model share one group even across states.
    expect(byKey["spark/qwen3.8-flash-next"]!.entries.map((entry) => entry.id)).toEqual(["a", "c"])
    expect(byKey["spark/qwen3.8-flash-next"]!.waiting).toEqual(["c"])
    expect(byKey["spark/qwen3.8-flash-next"]!.deviceKeys).toEqual(["spark-device"])
    expect(byKey["other/space-bunny-free"]!.entries[0]).toMatchObject({ id: "b", state: "interactive" })
  })

  test("a session in flight AND in the ledger appears once, with its ledger stats", () => {
    const groups = groupSchedulerByModel(
      [device({ deviceKey: "d", inFlightBatch: ["a"], ledger: [ledgerEntry("a"), ledgerEntry("a")] })],
      () => "m/model",
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]!.entries).toHaveLength(1)
    expect(groups[0]!.entries[0]).toMatchObject({ id: "a", state: "batch", ledger: { weight: 20 } })
  })

  test("an unresolvable session is shown, not dropped", () => {
    const groups = groupSchedulerByModel(
      [device({ deviceKey: "d", waiting: ["ghost"] })],
      () => undefined,
    )
    expect(groups[0]!.key).toBe(UNRESOLVED_MODEL)
    expect(groups[0]!.waiting).toEqual(["ghost"])
  })

  test("an older server that omits maintenance and concurrency still reads", () => {
    // A shape with no `concurrency` and no `inFlightMaintenance`, exactly as an older server sends.
    const legacy: SchedulerDevice = {
      deviceKey: "d",
      minRunMs: 0,
      inFlightInteractive: ["a"],
      inFlightBatch: [],
      waiting: [],
      ledger: [],
    }
    const groups = groupSchedulerByModel([legacy], () => "m/model")
    expect(groups[0]!.concurrency).toBe(0)
    expect(groups[0]!.entries.map((entry) => entry.id)).toEqual(["a"])
  })

  test("maintenance passes are grouped too, without occupying the waiting list", () => {
    const groups = groupSchedulerByModel(
      [device({ deviceKey: "d", inFlightMaintenance: ["job"], waiting: [] })],
      () => "m/model",
    )
    expect(groups[0]!.entries[0]).toMatchObject({ id: "job", state: "maintenance" })
    expect(groups[0]!.waiting).toEqual([])
  })
})
