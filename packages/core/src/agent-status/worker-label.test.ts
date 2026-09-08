import { describe, expect, test } from "bun:test"
import { fallbackWorkerLabel } from "./worker-label"

describe("worker label fallback", () => {
  test("keeps a verbose worker prompt out of the collapsed transcript row", () => {
    const prompt = "Please investigate the editor cursor race and add regression coverage for every affected path."
    const label = fallbackWorkerLabel(prompt)
    expect(label).toBe("investigate the editor cursor race")
    expect(label).not.toContain("regression coverage")
    expect(label!.split(" ")).toHaveLength(5)
  })

  test("does not manufacture a label for an empty prompt", () => {
    expect(fallbackWorkerLabel("  \n ")).toBeUndefined()
  })
})
