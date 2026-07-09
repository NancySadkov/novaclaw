import { describe, expect, test } from "bun:test"
import type { JhStep } from "./step"
import { JhTree } from "./tree"

const id = (s: string): JhStep.StepID => s as JhStep.StepID
const leaf = (goal: string): JhStep.StepDraft => ({ goal, size: "atomic", tool: "note", args: {}, success: "ok", check: { type: "artifact_present" } })
const compound = (goal: string, substeps: JhStep.StepDraft[]): JhStep.StepDraft => ({ goal, size: "needs_decomposition", success: "ok", substeps })

const mustAttach = (t: JhTree.Tree, parent: JhStep.StepID, drafts: JhStep.StepDraft[], maxDepth = 4): JhTree.Tree => {
  const r = JhTree.attach(t, parent, drafts, maxDepth)
  if (r instanceof JhTree.AttachError) throw new Error(`unexpected AttachError ${r.reason}: ${r.detail}`)
  return r
}

describe("JhTree", () => {
  test("create → single pending root, depth 0, size 1", () => {
    const t = JhTree.create(leaf("do the task"))
    expect(JhTree.size(t)).toBe(1)
    const root = JhTree.get(t, JhTree.ROOT_ID)!
    expect(root.status).toBe("pending")
    expect(root.depth).toBe(0)
    expect(root.parent).toBeUndefined()
    expect(root.children).toEqual([])
  })

  test("attach 3 drafts → ids root.1..root.3, parent expanded, children pending at depth 1", () => {
    const t = mustAttach(JhTree.create(leaf("root")), JhTree.ROOT_ID, [leaf("a"), leaf("b"), leaf("c")])
    expect(JhTree.get(t, JhTree.ROOT_ID)!.status).toBe("expanded")
    expect(JhTree.get(t, JhTree.ROOT_ID)!.children).toEqual([id("root.1"), id("root.2"), id("root.3")])
    for (const cid of ["root.1", "root.2", "root.3"]) {
      const n = JhTree.get(t, id(cid))!
      expect(n.status).toBe("pending")
      expect(n.depth).toBe(1)
      expect(n.parent).toBe(JhTree.ROOT_ID)
    }
  })

  test("nested attach → grandchildren root.2.1 etc.; middle node expanded", () => {
    const t = mustAttach(JhTree.create(leaf("root")), JhTree.ROOT_ID, [leaf("a"), compound("b", [leaf("b1"), leaf("b2")]), leaf("c")])
    expect(JhTree.get(t, id("root.2"))!.status).toBe("expanded")
    expect(JhTree.get(t, id("root.2.1"))!.depth).toBe(2)
    expect(JhTree.get(t, id("root.2.1"))!.status).toBe("pending")
    expect(JhTree.get(t, id("root.2.2"))!.parent).toBe(id("root.2"))
    expect(JhTree.size(t)).toBe(6) // root + 3 children + 2 grandchildren
  })

  test("attach errors: unknown_parent, already_expanded, empty, max_depth", () => {
    const t = JhTree.create(leaf("root"))
    const unknown = JhTree.attach(t, id("nope"), [leaf("a")], 4)
    expect((unknown as JhTree.AttachError).reason).toBe("unknown_parent")

    const attached = mustAttach(t, JhTree.ROOT_ID, [leaf("a")])
    const again = JhTree.attach(attached, JhTree.ROOT_ID, [leaf("b")], 4)
    expect((again as JhTree.AttachError).reason).toBe("already_expanded")

    const empty = JhTree.attach(t, JhTree.ROOT_ID, [], 4)
    expect((empty as JhTree.AttachError).reason).toBe("empty")

    // maxDepth 2, a 3-deep nested draft → root.1.1.1 at depth 3 exceeds.
    const tooDeep = JhTree.attach(t, JhTree.ROOT_ID, [compound("a", [compound("b", [leaf("c")])])], 2)
    expect((tooDeep as JhTree.AttachError).reason).toBe("max_depth")
  })

  test("nextPending preorder order across commits", () => {
    let t = mustAttach(JhTree.create(leaf("root")), JhTree.ROOT_ID, [leaf("a"), compound("b", [leaf("b1"), leaf("b2")]), leaf("c")])
    const seq: string[] = []
    for (;;) {
      const n = JhTree.nextPending(t)
      if (!n) break
      seq.push(n.id)
      t = JhTree.setStatus(t, n.id, "committed")
    }
    expect(seq).toEqual(["root.1", "root.2.1", "root.2.2", "root.3"])
  })

  test("immutability: setStatus returns a new tree; the old one is unchanged", () => {
    const t0 = JhTree.create(leaf("root"))
    const t1 = JhTree.setStatus(t0, JhTree.ROOT_ID, "committed")
    expect(JhTree.get(t0, JhTree.ROOT_ID)!.status).toBe("pending")
    expect(JhTree.get(t1, JhTree.ROOT_ID)!.status).toBe("committed")
  })

  test("allChildrenCommitted false→true; ancestors(root.2.1) = [root, root.2]", () => {
    let t = mustAttach(JhTree.create(leaf("root")), JhTree.ROOT_ID, [leaf("a"), compound("b", [leaf("b1"), leaf("b2")]), leaf("c")])
    expect(JhTree.allChildrenCommitted(t, id("root.2"))).toBe(false)
    t = JhTree.setStatus(t, id("root.2.1"), "committed")
    expect(JhTree.allChildrenCommitted(t, id("root.2"))).toBe(false)
    t = JhTree.setStatus(t, id("root.2.2"), "committed")
    expect(JhTree.allChildrenCommitted(t, id("root.2"))).toBe(true)
    expect(JhTree.ancestors(t, id("root.2.1")).map((n): string => n.id)).toEqual(["root", "root.2"])
  })
})
