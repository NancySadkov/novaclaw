import { describe, expect, test } from "bun:test"
import { planSteps, type StepInfo } from "./revert"

// Pure planner tests. seq order, in-flight step excluded — exactly what loadSteps feeds it.
const step = (id: string, start: string | undefined, files: string[]): StepInfo => ({ id, start, files })

describe("revert planSteps", () => {
  test("steps=1 undoes only the last file-changing step (first-touch tree)", () => {
    const rows = [
      step("m1", "t1", ["a.txt"]),
      step("m2", "t2", ["b.txt"]),
      step("m3", "t3", []), // changed nothing
    ]
    const { files } = planSteps(rows, 1)
    expect([...files.entries()]).toEqual([["b.txt", "t2"]])
  })

  test("steps=2 maps overlapping files to the EARLIEST step's tree", () => {
    const rows = [step("m1", "t1", ["a.txt"]), step("m2", "t2", ["a.txt", "b.txt"]), step("m3", "t3", ["b.txt"])]
    const { files } = planSteps(rows, 2)
    // m2 + m3 are undone: a.txt/b.txt restore to their state BEFORE m2 (tree t2).
    expect(files.get("a.txt")).toBe("t2")
    expect(files.get("b.txt")).toBe("t2")
    expect(files.size).toBe(2)
  })

  test("steps beyond history reverts everything recorded", () => {
    const rows = [step("m1", "t1", ["a.txt"]), step("m2", "t2", ["b.txt"])]
    const { files } = planSteps(rows, 50)
    expect(files.get("a.txt")).toBe("t1")
    expect(files.get("b.txt")).toBe("t2")
  })

  test("non-changing steps between changing ones do not shift the count", () => {
    const rows = [
      step("m1", "t1", ["a.txt"]),
      step("m2", "t2", []),
      step("m3", "t3", ["b.txt"]),
      step("m4", "t4", []),
    ]
    const { files } = planSteps(rows, 1)
    expect([...files.entries()]).toEqual([["b.txt", "t3"]])
  })

  test("steps without a snapshot are not counted as changing steps", () => {
    const rows = [step("m1", undefined, ["ghost.txt"]), step("m2", "t2", ["real.txt"])]
    const { files } = planSteps(rows, 2)
    expect(files.has("ghost.txt")).toBe(false)
    expect(files.get("real.txt")).toBe("t2")
  })

  test("empty history / zero steps plan nothing", () => {
    expect(planSteps([], 1).files.size).toBe(0)
    expect(planSteps([step("m1", "t1", ["a.txt"])], 0).files.size).toBe(0)
  })
})
