import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { JhStep } from "./step"

const decode = Schema.decodeUnknownSync(JhStep.StepDraft)

// A clean atomic leaf reused as a valid substep in several fixtures.
const cleanLeaf: JhStep.StepDraft = {
  goal: "sub",
  size: "atomic",
  tool: "note",
  args: { text: "x" },
  success: "notes something",
  check: { type: "artifact_present" },
}

describe("StepDraft codec", () => {
  test("full valid atomic draft decodes (all fields incl. run check + args)", () => {
    const input = {
      goal: "run the test suite",
      research_needed: false,
      consumes: [{ id: "add.c", type: "file" }],
      produces: [{ id: "pi-output", type: "command_output" }],
      tool: "run",
      args: { command: "gcc --version" },
      size: "atomic",
      difficulty_prior: "moderate",
      success: "exit code 0",
      check: { type: "run", command: "gcc --version", expect: "gcc", timeoutMs: 5000 },
      assumptions: ["gcc is installed"],
    }
    const draft = decode(input)
    expect(draft.goal).toBe("run the test suite")
    expect(draft.tool).toBe("run")
    expect(draft.args).toEqual({ command: "gcc --version" })
    expect(draft.check).toEqual({ type: "run", command: "gcc --version", expect: "gcc", timeoutMs: 5000 })
    expect(draft.consumes?.[0]).toEqual({ id: "add.c", type: "file" })
  })

  test("minimal atomic draft decodes (only goal/size/success/tool/args)", () => {
    const draft = decode({ goal: "note the plan", size: "atomic", success: "records a choice", tool: "note", args: { text: "hi" } })
    expect(draft.size).toBe("atomic")
    expect(draft.research_needed).toBeUndefined()
    expect(draft.check).toBeUndefined()
    expect(draft.substeps).toBeUndefined()
  })

  test("compound draft with nested substeps (one 3 deep) decodes; substeps typed as StepDraft", () => {
    const input = {
      goal: "build the library",
      size: "needs_decomposition",
      success: "all parts compile",
      substeps: [
        { goal: "leaf one", size: "atomic", tool: "note", args: {}, success: "ok" },
        {
          goal: "mid",
          size: "needs_decomposition",
          success: "children done",
          substeps: [
            {
              goal: "deep",
              size: "needs_decomposition",
              success: "grandchild done",
              substeps: [{ goal: "leaf three", size: "atomic", tool: "note", args: {}, success: "ok" }],
            },
          ],
        },
      ],
    }
    const draft = decode(input)
    expect(draft.substeps?.length).toBe(2)
    // 3-deep nesting preserved and typed as StepDraft.
    const deepLeaf: JhStep.StepDraft | undefined = draft.substeps?.[1]?.substeps?.[0]?.substeps?.[0]
    expect(deepLeaf?.goal).toBe("leaf three")
  })

  test("TOLERANCE: null-valued optional fields decode (small models emit `null` for absent fields)", () => {
    const draft = decode({ goal: "g", size: "atomic", tool: "note", args: {}, substeps: null, consumes: null, check: null, difficulty_prior: null, research_needed: null })
    expect(draft.substeps).toBeNull()
    expect(draft.check).toBeNull()
    // downstream `?? default` collapses null and undefined
    expect(draft.substeps ?? []).toEqual([])
    expect(draft.check ?? { type: "artifact_present" }).toEqual({ type: "artifact_present" })
  })

  test("TOLERANCE: `success` is optional (it is human legibility; the gate is `check` — D4)", () => {
    const draft = decode({ goal: "g", size: "needs_decomposition", substeps: [{ goal: "a", size: "atomic", tool: "note", args: {} }] })
    expect(draft.success).toBeUndefined()
    expect(draft.substeps?.[0]?.goal).toBe("a")
  })

  test("TOLERANCE: coerceDraftShape wraps a lone {id,type} object into an array (produces/consumes/substeps)", () => {
    const coerced: any = JhStep.coerceDraftShape({
      goal: "g",
      size: "atomic",
      tool: "write_file",
      args: {},
      produces: { id: "pi.c", type: "file" }, // lone object, not an array
      consumes: { id: "add.c", type: "file" },
    })
    expect(coerced.produces).toEqual([{ id: "pi.c", type: "file" }])
    expect(coerced.consumes).toEqual([{ id: "add.c", type: "file" }])
    // recurses into a lone substep and decodes cleanly
    const nested: any = JhStep.coerceDraftShape({ goal: "r", size: "needs_decomposition", substeps: { goal: "a", size: "atomic", tool: "note", args: {}, produces: { id: "x", type: "note" } } })
    expect(Array.isArray(nested.substeps)).toBe(true)
    const draft = decode(nested)
    expect(draft.substeps?.[0]?.produces).toEqual([{ id: "x", type: "note" }])
  })

  test("codec REJECTS missing goal, size:'huge', and an unknown check type", () => {
    expect(() => decode({ size: "atomic", success: "s", tool: "note", args: {} })).toThrow()
    expect(() => decode({ goal: "g", size: "huge", success: "s" })).toThrow()
    expect(() => decode({ goal: "g", size: "atomic", success: "s", tool: "note", args: {}, check: { type: "nope" } })).toThrow()
  })
})

describe("structuralIssues", () => {
  const has = (issues: ReadonlyArray<JhStep.StructuralIssue>, code: JhStep.StructuralIssue["code"]) =>
    issues.find((i) => i.code === code)

  test("empty_goal (error, path '')", () => {
    const issue = has(JhStep.structuralIssues({ goal: "   ", size: "atomic", tool: "note", args: {}, success: "s", check: { type: "artifact_present" } }), "empty_goal")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("atomic_with_substeps (error, path '')", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "atomic", tool: "note", args: {}, success: "s", check: { type: "artifact_present" }, substeps: [cleanLeaf] }), "atomic_with_substeps")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("compound_without_substeps (error, path '')", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "needs_decomposition", success: "s" }), "compound_without_substeps")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("atomic_missing_tool (error)", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "atomic", args: {}, success: "s", check: { type: "artifact_present" } }), "atomic_missing_tool")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("compound_with_tool (error)", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "needs_decomposition", tool: "note", success: "s", substeps: [cleanLeaf] }), "compound_with_tool")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("atomic_missing_args (error)", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "atomic", tool: "note", success: "s", check: { type: "artifact_present" } }), "atomic_missing_args")
    expect(issue).toMatchObject({ severity: "error", path: "" })
  })

  test("atomic_missing_check (WARNING)", () => {
    const issue = has(JhStep.structuralIssues({ goal: "g", size: "atomic", tool: "note", args: {}, success: "s" }), "atomic_missing_check")
    expect(issue).toMatchObject({ severity: "warning", path: "" })
  })

  test("bad_artifact_id (error, path 'produces[0]', detail = the bad id)", () => {
    const issue = has(
      JhStep.structuralIssues({
        goal: "g",
        size: "atomic",
        tool: "note",
        args: {},
        success: "s",
        check: { type: "artifact_present" },
        produces: [{ id: "BAD ID!", type: "file" }],
      }),
      "bad_artifact_id",
    )
    expect(issue).toMatchObject({ severity: "error", path: "produces[0]", detail: "BAD ID!" })
  })

  test("nested bad_artifact_id carries the extended path", () => {
    const issues = JhStep.structuralIssues({
      goal: "g",
      size: "needs_decomposition",
      success: "s",
      substeps: [cleanLeaf, { ...cleanLeaf, consumes: [{ id: "Bad", type: "file" }] }],
    })
    expect(has(issues, "bad_artifact_id")).toMatchObject({ path: "substeps[1].consumes[0]" })
  })

  test("clean 2-level fixture → zero issues", () => {
    const clean: JhStep.StepDraft = {
      goal: "build the thing",
      size: "needs_decomposition",
      success: "all subparts done",
      substeps: [cleanLeaf, { ...cleanLeaf, goal: "sub two" }],
    }
    expect(JhStep.structuralIssues(clean)).toEqual([])
  })
})
