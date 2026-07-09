import { describe, expect, test } from "bun:test"
import type { JhStep } from "./step"
import { JhTree } from "./tree"
import { JhDataflow } from "./dataflow"
import { JhFixtures } from "./fixtures"

const id = (s: string): JhStep.StepID => s as JhStep.StepID
const ar = (x: string): JhStep.ArtifactRef => ({ id: x, type: "file" })
const io = (goal: string, consumes: string[], produces: string[]): JhStep.StepDraft => ({
  goal,
  size: "atomic",
  tool: "note",
  args: {},
  success: "ok",
  consumes: consumes.map(ar),
  produces: produces.map(ar),
  check: { type: "artifact_present" },
})

const buildTree = (draft: JhStep.StepDraft): JhTree.Tree => {
  const { substeps, ...root } = draft
  const r = JhTree.attach(JhTree.create(root), JhTree.ROOT_ID, substeps ?? [], 8)
  if (r instanceof JhTree.AttachError) throw new Error(`attach failed: ${r.reason} ${r.detail}`)
  return r
}

describe("JhDataflow.validate (law 7)", () => {
  test("fixture root decomposition: zero errors, one unused_produce warning (verdict)", () => {
    const issues = JhDataflow.validate(JhFixtures.piTree.substeps!, new Set())
    expect(issues.filter((i) => i.severity === "error")).toEqual([])
    const warnings = issues.filter((i) => i.severity === "warning")
    expect(warnings).toEqual([{ severity: "warning", code: "unused_produce", step: 5, artifact: "verdict" }])
  })

  test("dangling: a child consuming an unproduced artifact → error with step index + artifact", () => {
    const issues = JhDataflow.validate([io("only", ["missing.c"], [])], new Set())
    expect(issues).toContainEqual({ severity: "error", code: "dangling_consumes", step: 0, artifact: "missing.c" })
  })

  test("order matters: consumer before producer → dangling_consumes", () => {
    const issues = JhDataflow.validate([io("a", ["x"], []), io("b", [], ["x"])], new Set())
    expect(issues.some((i) => i.code === "dangling_consumes" && i.step === 0 && i.artifact === "x")).toBe(true)
  })

  test("satisfied: producer before consumer, and ancestor-provided → no dangling", () => {
    const forward = JhDataflow.validate([io("a", [], ["x"]), io("b", ["x"], [])], new Set())
    expect(forward.filter((i) => i.code === "dangling_consumes")).toEqual([])
    const ancestor = JhDataflow.validate([io("a", ["x"], [])], new Set(["x"]))
    expect(ancestor).toEqual([]) // consume satisfied, nothing produced
  })

  test("duplicate produce: across siblings and against available → error", () => {
    const siblings = JhDataflow.validate([io("a", [], ["x"]), io("b", [], ["x"])], new Set())
    expect(siblings.some((i) => i.code === "duplicate_produce" && i.step === 1 && i.artifact === "x")).toBe(true)
    const vsAvail = JhDataflow.validate([io("a", [], ["x"])], new Set(["x"]))
    expect(vsAvail.some((i) => i.code === "duplicate_produce" && i.step === 0 && i.artifact === "x")).toBe(true)
  })

  test("self-loop: consume+produce same id with no earlier producer → dangling_consumes", () => {
    const issues = JhDataflow.validate([io("a", ["x"], ["x"])], new Set())
    expect(issues.some((i) => i.code === "dangling_consumes" && i.step === 0 && i.artifact === "x")).toBe(true)
  })
})

describe("JhDataflow.density", () => {
  test("fixture root children density === 13", () => {
    expect(JhDataflow.density(JhFixtures.piTree.substeps!)).toBe(13)
  })
})

describe("JhDataflow.closure / cardinality", () => {
  const t = buildTree(JhFixtures.piTree)

  test("closure(s6) is the full 8-artifact upstream set; cardinality 8", () => {
    expect(JhDataflow.cardinality(t, id("root.6"))).toBe(8)
    expect(JhDataflow.closure(t, id("root.6"))).toEqual(
      new Set(["pi-output", "machin.c", "algorithm-choice", "add.c", "sub.c", "mul.c", "div.c", "arctan.c"]),
    )
  })

  test("closure(s3) has 5; closure(s2.1) is empty", () => {
    expect(JhDataflow.closure(t, id("root.3")).size).toBe(5)
    expect(JhDataflow.closure(t, id("root.2.1")).size).toBe(0)
  })

  test("diamond dedups (u once), cycle terminates", () => {
    const diamond = buildTree({
      goal: "d",
      size: "needs_decomposition",
      success: "x",
      substeps: [io("p", [], ["u"]), io("a", ["u"], ["x"]), io("b", ["u"], ["y"]), io("c", ["x", "y"], ["z"])],
    })
    expect(JhDataflow.closure(diamond, id("root.4"))).toEqual(new Set(["x", "y", "u"]))

    const cyclic = buildTree({
      goal: "c",
      size: "needs_decomposition",
      success: "x",
      substeps: [io("one", ["b"], ["a"]), io("two", ["a"], ["b"])],
    })
    // a→b→a in the declarations; the visited/dedup guard makes this terminate (own produce `a` excluded).
    expect(JhDataflow.closure(cyclic, id("root.1"))).toEqual(new Set(["b"]))
  })
})
