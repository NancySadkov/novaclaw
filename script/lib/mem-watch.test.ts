import { describe, expect, test } from "bun:test"
import { watchMemoryKill } from "./mem-watch"

const immediate = () => Promise.resolve()

describe("watchMemoryKill", () => {
  test("fires once the sampled tree reaches the cap, reporting the peak", async () => {
    const readings = [100, 5000, 9000]
    let breaches = 0
    let firedAt = -1
    const watch = watchMemoryKill({
      sample: () => readings.shift(),
      capMb: 8000,
      onBreach: (peak) => {
        breaches++
        firedAt = peak
      },
      sleepMs: immediate,
      intervalMs: 1,
    })
    await watch.finished
    expect(breaches).toBe(1)
    expect(firedAt).toBe(9000)
    expect(watch.peakMb).toBe(9000)
  })

  test("a tree that never reaches the cap never fires", async () => {
    let breaches = 0
    const watch = watchMemoryKill({
      sample: () => 100,
      capMb: 8000,
      onBreach: () => breaches++,
      sleepMs: immediate,
      intervalMs: 1,
    })
    // Let several polls elapse, then stop it like a finished unit would.
    await immediate()
    await immediate()
    await immediate()
    watch.settle()
    await watch.finished
    expect(breaches).toBe(0)
    expect(watch.peakMb).toBeUndefined()
  })

  test("an unreadable sampler (undefined) is not a breach", async () => {
    let breaches = 0
    const watch = watchMemoryKill({
      sample: () => undefined,
      capMb: 8000,
      onBreach: () => breaches++,
      sleepMs: immediate,
      intervalMs: 1,
    })
    await immediate()
    await immediate()
    watch.settle()
    await watch.finished
    expect(breaches).toBe(0)
  })

  test("settle() before the first poll fires nothing and never samples", async () => {
    let breaches = 0
    let samples = 0
    const watch = watchMemoryKill({
      sample: () => {
        samples++
        return 999_999
      },
      capMb: 8000,
      onBreach: () => breaches++,
      sleepMs: immediate,
      intervalMs: 1,
    })
    // Synchronous: the loop's first await hasn't run yet, so settling now must win the race.
    watch.settle()
    await watch.finished
    expect(breaches).toBe(0)
    expect(samples).toBe(0)
    expect(watch.peakMb).toBeUndefined()
  })

  test("a throwing sampler leaves the unit on bare instead of red", async () => {
    let calls = 0
    const watch = watchMemoryKill({
      sample: () => {
        calls++
        if (calls > 2) throw new Error("probe died")
        return 100
      },
      capMb: 8000,
      onBreach: () => {
        throw new Error("must not fire")
      },
      sleepMs: immediate,
      intervalMs: 1,
    })
    await watch.finished
    expect(watch.peakMb).toBeUndefined()
  })
})
