import { describe, expect, test } from "bun:test"
import { JhContext } from "./context"

const block = (id: string, content: string): JhContext.ArtifactBlock => ({ id, type: "file", content })

const base = {
  taskGoal: "T",
  ancestorGoals: [] as string[],
  stepGoal: "S",
}

describe("JhContext.assemble", () => {
  test("direct then transitive, in order", () => {
    const out = JhContext.assemble({ ...base, direct: [block("a", "aa"), block("b", "bb")], transitive: [block("c", "cc")] })
    expect(out.indexOf("artifact a")).toBeLessThan(out.indexOf("artifact b"))
    expect(out.indexOf("artifact b")).toBeLessThan(out.indexOf("artifact c"))
  })

  test("a non-closure artifact is absent (only given blocks render)", () => {
    const out = JhContext.assemble({ ...base, direct: [block("algorithm-choice", "Machin"), block("add.c", "int add")], transitive: [] })
    expect(out).not.toContain("machin.c")
  })

  test("per-artifact elision preserves head/tail and marks the gap", () => {
    const content = "START" + "-".repeat(500) + "FINISH" // 511 chars
    const out = JhContext.assemble({ ...base, direct: [block("big", content)], transitive: [], limits: { perArtifactChars: 100, totalChars: 100_000 } })
    expect(out).toContain("START")
    expect(out).toContain("FINISH")
    expect(out).toContain("…[elided 421 chars]…") // 511 - floor(60) - floor(30)
    expect(out).not.toContain("-".repeat(200)) // the middle really was cut
  })

  test("total-budget drop removes transitive from the end, never direct", () => {
    const out = JhContext.assemble({
      ...base,
      direct: [block("d1", "D".repeat(200))],
      transitive: [block("t1", "1".repeat(200)), block("t2", "2".repeat(200)), block("t3", "3".repeat(200))],
      limits: { perArtifactChars: 1000, totalChars: 500 },
    })
    expect(out).toContain("D".repeat(50)) // direct never dropped
    expect(out).not.toContain("3".repeat(50)) // deepest transitive dropped
    expect(out.length).toBeLessThanOrEqual(500)
  })

  test("byte-identical across two calls with the same input (determinism)", () => {
    const input = { ...base, direct: [block("a", "hello")], transitive: [block("b", "world")] }
    expect(JhContext.assemble(input)).toBe(JhContext.assemble(input))
  })

  test("empty artifacts → goals only, no Inputs section", () => {
    const out = JhContext.assemble({ taskGoal: "the task", ancestorGoals: ["outer"], stepGoal: "the step", direct: [], transitive: [] })
    expect(out).toContain("the task")
    expect(out).toContain("the step")
    expect(out).toContain("- outer")
    expect(out).not.toContain("# Inputs")
  })
})
