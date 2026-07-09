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

  test("mustDecompose → the force line", () => {
    const p = JhExpander.introspectPrompt({ ...base, mustDecompose: true })
    expect(p.system).toContain("MUST decompose")
    expect(p.system).toContain("2–8 substeps")
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
