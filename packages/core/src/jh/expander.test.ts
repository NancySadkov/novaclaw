import { describe, expect, test } from "bun:test"
import { JhExpander } from "./expander"

const base = {
  taskGoal: "build a C program",
  stepGoal: "write add()",
  context: "CONTEXT_MARKER_12345",
  toolNames: ["write_file", "read_file", "run", "note"],
  allowDecomposition: true,
  mustDecompose: false,
}

describe("introspectPrompt", () => {
  test("contains every tool, the step goal, the context verbatim, and the JSON-fence instruction", () => {
    const p = JhExpander.introspectPrompt(base)
    for (const t of base.toolNames) expect(p.system).toContain(t)
    expect(p.user).toContain("write add()")
    expect(p.user).toContain("CONTEXT_MARKER_12345")
    expect(p.system).toContain("```json")
  })

  test("allowDecomposition:false → no-decompose line, no substeps encouragement", () => {
    const p = JhExpander.introspectPrompt({ ...base, allowDecomposition: false })
    expect(p.system).toContain("may NOT decompose")
    expect(p.system).not.toContain("2–8 substeps")
  })

  test("mustDecompose → the force line (lazy phases by default; flag-off = wave-2 wording)", () => {
    const p = JhExpander.introspectPrompt({ ...base, mustDecompose: true })
    expect(p.system).toContain("MUST decompose")
    expect(p.system).toContain("TOP-LEVEL phases") // improve3 P3a: lazy = phases-only
    const p2 = JhExpander.introspectPrompt({ ...base, mustDecompose: true, lazyPlan: false })
    expect(p2.system).toContain("2–8 substeps") // flag-off restores wave-2
  })

  test("formatReminder lands in the user message, not the system", () => {
    const p = JhExpander.introspectPrompt({ ...base, formatReminder: "REMINDER_XYZ" })
    expect(p.user).toContain("REMINDER_XYZ")
    expect(p.system).not.toContain("REMINDER_XYZ")
  })

  test("environment description is injected into the system prompt when provided", () => {
    const p = JhExpander.introspectPrompt({ ...base, environment: "FRESH shell; set PATH inside each command" })
    expect(p.system).toContain("Execution environment:")
    expect(p.system).toContain("FRESH shell; set PATH inside each command")
    // absent when not provided
    expect(JhExpander.introspectPrompt(base).system).not.toContain("Execution environment:")
  })
})

describe("parseReply", () => {
  test("happy atomic", () => {
    const r = JhExpander.parseReply('```json\n{"goal":"g","size":"atomic","tool":"note","args":{"text":"x"},"success":"ok"}\n```')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.draft.tool).toBe("note")
  })

  test("happy compound preserves substeps", () => {
    const reply = '{"goal":"g","size":"needs_decomposition","success":"ok","substeps":[{"goal":"a","size":"atomic","tool":"note","args":{},"success":"ok"}]}'
    const r = JhExpander.parseReply(reply)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.draft.substeps?.[0]?.goal).toBe("a")
  })

  test("tolerates a lone {id,type} produces object (coerced to an array)", () => {
    const r = JhExpander.parseReply('{"goal":"g","size":"atomic","tool":"write_file","args":{"path":"pi.c","content":"x"},"produces":{"id":"pi.c","type":"file"}}')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.draft.produces).toEqual([{ id: "pi.c", type: "file" }])
  })

  test("garbage → issue mentioning the extract reason", () => {
    const r = JhExpander.parseReply("no json here at all")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issue).toContain("no_json")
  })

  test("valid JSON, wrong shape → issue mentioning the failing field", () => {
    const r = JhExpander.parseReply('{"size":"atomic"}') // missing goal + success
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.issue).toContain("goal")
  })
})

// improve12.1 — wrong-shape TOLERANCE (§12: repair before rejecting). The three rules pin the probe
// anatomy (30/32 baseline parse failures across seeds 12300-12301 were exactly these shapes).
describe("parseReply wrong-shape coercion (improve12.1)", () => {
  test("R1 (17/32): the tool-call shape — tool/args without goal adopts the caller's fallbackGoal", () => {
    const r = JhExpander.parseReply('{"tool":"edit_file","args":{"path":"a.c","old_string":"x","new_string":"y"},"check":{"type":"compile","command":"gcc -c a.c"}}', { fallbackGoal: "fix the carry bug" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.goal).toBe("fix the carry bug")
      expect(r.draft.size).toBe("atomic") // R2 kicked in too (tool present)
      expect(r.draft.tool).toBe("edit_file")
    }
  })
  test("R1 variant: the OpenAI-native {name, arguments} shape is remapped", () => {
    const r = JhExpander.parseReply('{"name":"run","arguments":{"command":"gcc -c a.c"}}', { fallbackGoal: "compile it" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.tool).toBe("run")
      expect((r.draft.args as { command?: string }).command).toBe("gcc -c a.c")
    }
  })
  test("R2 (11/32): missing size in substeps is inferred (atomic without substeps)", () => {
    const r = JhExpander.parseReply('{"goal":"plan","size":"needs_decomposition","substeps":[{"goal":"phase 1"},{"goal":"phase 2","tool":"note","args":{}}]}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.substeps?.[0]?.size).toBe("atomic") // no tool/substeps — but SIZE is inferable... see R2 note
      expect(r.draft.substeps?.[1]?.size).toBe("atomic")
    }
  })
  test("R3 (3/32): STRING substeps become atomic phase children", () => {
    const r = JhExpander.parseReply('{"goal":"plan","size":"needs_decomposition","substeps":["Phase 1: build primitives","Phase 2: compute Pi"]}')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.draft.substeps?.length).toBe(2)
      expect(r.draft.substeps?.[0]?.goal).toBe("Phase 1: build primitives")
      expect(r.draft.substeps?.[0]?.size).toBe("atomic")
    }
  })
  test("never guess: no tool, no substeps, no goal → still rejected", () => {
    const r = JhExpander.parseReply('{"success":"ok"}', { fallbackGoal: "g" })
    expect(r.ok).toBe(false)
  })
  test("without fallbackGoal the tool-call shape still fails (no invented goals)", () => {
    const r = JhExpander.parseReply('{"tool":"run","args":{"command":"x"}}')
    expect(r.ok).toBe(false)
  })
})

describe("stepJsonSchema", () => {
  test("emits the recursive schema (substeps + $defs/$ref)", () => {
    const json = JSON.stringify(JhExpander.stepJsonSchema())
    expect(json).toContain("substeps")
    expect(/\$defs|\$ref/.test(json)).toBe(true)
  })
})

describe("dataflowRepairReminder", () => {
  test("lists the offending issues", () => {
    const msg = JhExpander.dataflowRepairReminder([{ severity: "error", code: "dangling_consumes", step: 1, artifact: "x.c" }])
    expect(msg).toContain("dangling_consumes")
    expect(msg).toContain("x.c")
  })
})

describe("goalCheckPrompt / parseGoalCheck", () => {
  test("prompt carries the goal and workspace", () => {
    const p = JhExpander.goalCheckPrompt({ goal: "compile and verify 100 digits of Pi", workspace: "### pi.c\n...\n" })
    expect(p.user).toContain("compile and verify 100 digits of Pi")
    expect(p.user).toContain("pi.c")
    expect(p.system).toContain("compiled")
  })
  test("prompt includes the most recent program stdout when given (so wrong output is checkable)", () => {
    const p = JhExpander.goalCheckPrompt({ goal: "print 100 digits of Pi", workspace: "### pi.c", lastOutput: "Pi = 3.0000000" })
    expect(p.user).toContain("Most recent program output")
    expect(p.user).toContain("Pi = 3.0000000")
    expect(p.system).toContain("wrong digits") // instructs the checker to compare against the true value
  })
  test("parses achieved:true", () => {
    expect(JhExpander.parseGoalCheck('```json\n{"achieved": true, "missing": ""}\n```')).toEqual({ achieved: true, missing: "" })
  })
  test("parses achieved:false with a missing phrase", () => {
    expect(JhExpander.parseGoalCheck('{"achieved": false, "missing": "not compiled"}')).toEqual({ achieved: false, missing: "not compiled" })
  })
  test("unparseable → not achieved (fail-safe)", () => {
    expect(JhExpander.parseGoalCheck("no json here").achieved).toBe(false)
  })
  test("a non-true 'achieved' is treated as not achieved", () => {
    expect(JhExpander.parseGoalCheck('{"achieved": "yes"}').achieved).toBe(false)
  })
  test("R2: parses the evidence quote when present, undefined when absent", () => {
    expect(JhExpander.parseGoalCheck('{"achieved": true, "missing": "", "evidence": "3.14159"}')).toEqual({ achieved: true, missing: "", evidence: "3.14159" })
    expect(JhExpander.parseGoalCheck('{"achieved": true, "missing": ""}').evidence).toBeUndefined()
    expect(JhExpander.parseGoalCheck('{"achieved": true, "evidence": 42}').evidence).toBeUndefined() // non-string ignored
  })
  test("R2: the prompt asks for a verbatim evidence quote", () => {
    const p = JhExpander.goalCheckPrompt({ goal: "print Pi", workspace: "### pi.c" })
    expect(p.system).toContain("evidence")
    expect(p.system.toLowerCase()).toContain("verbatim")
  })
})
