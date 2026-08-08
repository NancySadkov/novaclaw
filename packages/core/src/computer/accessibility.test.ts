import { describe, expect, test } from "bun:test"
import { ComputerAccessibility as A11y } from "./accessibility"

const viewport = { width: 1280, height: 800 }
const node = (over: Record<string, unknown> = {}) => ({
  id: "app/0/button/4",
  role: "push button",
  name: "Save",
  bounds: { x: 900, y: 720, width: 100, height: 40 },
  actions: ["click"],
  ...over,
})

describe("P5 accessibility candidate boundary", () => {
  test("keeps a named, uniquely identified, on-screen control", () => {
    const result = A11y.normalize([node()], viewport)
    expect(result.rejected).toEqual([])
    expect(result.candidates).toEqual([node()])
  })

  test("rejects both sides of an id collision", () => {
    const result = A11y.normalize([node(), node({ name: "Cancel" })], viewport)
    expect(result.candidates).toEqual([])
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "duplicate id: app/0/button/4",
      "duplicate id: app/0/button/4",
    ])
  })

  test.each([...A11y.CONTAINER_ANTI_PATTERNS])("rejects the container anti-pattern %s", (container) => {
    expect(A11y.normalize([node({ role: container })], viewport).candidates).toEqual([])
    expect(A11y.normalize([node({ name: container })], viewport).candidates).toEqual([])
  })

  test("rejects nameless, id-less, malformed and off-screen nodes", () => {
    const result = A11y.normalize(
      [node({ name: " " }), node({ id: "" }), null, node({ bounds: { x: 1270, y: 0, width: 20, height: 20 } })],
      viewport,
    )
    expect(result.candidates).toEqual([])
    expect(result.rejected).toHaveLength(4)
  })

  test("selection requires the supplied id and that node's exact own name", () => {
    const candidates = A11y.normalize([node()], viewport).candidates
    expect(A11y.select(candidates, "app/0/button/4", "Save").ok).toBe(true)
    expect(A11y.select(candidates, "app/0/button/4", "Save button").ok).toBe(false)
    expect(A11y.select(candidates, "missing", "Save").ok).toBe(false)
  })

  test("the projection is bounded and names omitted candidates", () => {
    const candidates = A11y.normalize(
      [node(), node({ id: "app/0/button/5", name: "Cancel", actions: [] })],
      viewport,
    ).candidates
    expect(A11y.render(candidates, 1)).toBe('app/0/button/4\tpush button\t"Save"\t900,720,100,40\tclick\n… 1 more omitted')
    expect(A11y.render([])).toContain("use the screenshot channel")
  })
})
