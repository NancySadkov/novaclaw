import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhProbe } from "./probe"

describe("JhProbe.batteryTask", () => {
  test("deterministic: same seed → identical numbers and sum", () => {
    const a = JhProbe.batteryTask(5, 42)
    const b = JhProbe.batteryTask(5, 42)
    expect(a.artifacts.map((x) => x.content)).toEqual(b.artifacts.map((x) => x.content))
    expect(a.expected).toBe(b.expected)
  })

  test("exactly k artifacts, all 4-digit; expected is their true sum", () => {
    const t = JhProbe.batteryTask(7, 1)
    expect(t.artifacts.length).toBe(7)
    for (const a of t.artifacts) {
      expect(a.type).toBe("note")
      expect(Number(a.content)).toBeGreaterThanOrEqual(1000)
      expect(Number(a.content)).toBeLessThanOrEqual(9999)
    }
    const sum = t.artifacts.reduce((s, a) => s + Number(a.content), 0)
    expect(t.expected).toBe(String(sum))
  })

  test("different seeds → different values", () => {
    expect(JhProbe.batteryTask(3, 1).expected).not.toBe(JhProbe.batteryTask(3, 999).expected)
  })

  test("the goal inlines every value (the model can't see consumes-less root context)", () => {
    const t = JhProbe.batteryTask(4, 3)
    for (const a of t.artifacts) expect(t.stepGoal).toContain(a.content)
  })
})

describe("JhProbe.staircaseDriver", () => {
  test("converges near the true boundary (scripted run: pass iff k ≤ 7)", async () => {
    const result = await Effect.runPromise(
      JhProbe.staircaseDriver({
        run: (task) => Effect.succeed(task.k <= 7),
        seed: 1,
        start: 3,
        stepSize: 2,
        maxProbes: 20,
      }),
    )
    expect(result.estimate).toBeDefined()
    expect(result.estimate!).toBeGreaterThanOrEqual(6)
    expect(result.estimate!).toBeLessThanOrEqual(9)
    // up-down rule: after a pass k should not have decreased; after a fail it should not have increased.
    for (let i = 1; i < result.trace.length; i++) {
      if (result.trace[i - 1]!.passed) expect(result.trace[i]!.k).toBeGreaterThanOrEqual(result.trace[i - 1]!.k)
      else expect(result.trace[i]!.k).toBeLessThanOrEqual(result.trace[i - 1]!.k)
    }
  })

  test("step-halving after the first reversal (step 2 → 1)", async () => {
    const result = await Effect.runPromise(
      JhProbe.staircaseDriver({ run: (task) => Effect.succeed(task.k <= 7), seed: 5, start: 3, stepSize: 2, maxProbes: 20 })
    )
    // Early climb uses step 2 (3,5,7...), later refinement moves by 1 (7,8,7,8...).
    const ks = result.trace.map((t) => t.k)
    expect(ks.slice(0, 3)).toEqual([3, 5, 7])
    // once refined, consecutive differences are ≤ 1
    const tail = ks.slice(-4)
    for (let i = 1; i < tail.length; i++) expect(Math.abs(tail[i]! - tail[i - 1]!)).toBeLessThanOrEqual(1)
  })
})
