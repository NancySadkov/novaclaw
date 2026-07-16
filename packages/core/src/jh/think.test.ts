// improve19 — the THINK/DO split (`notes/jh-think-stage.md`, owner design).
//
// jh disabled the `<think>` channel in wave 1 because reasoning and JSON-formatting fight inside one
// call ("burns the entire token budget in <think> and returns EMPTY content"). Aider hit the same
// wall and SPLIT the roles instead of amputating (architect+editor = 85% SOTA). These tests pin that
// split's contract: the plan reaches the DO call, the DO call still fills the schema, and a think
// stage that fails or runs away NEVER costs the step (the improve1 ghost, caught by fall-through).
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "@novaclaw/core/jh/artifact"
import { JhBudget } from "@novaclaw/core/jh/budget"
import { JhEngine } from "@novaclaw/core/jh/engine"
import { JhExpander } from "@novaclaw/core/jh/expander"
import { JhBasicTools } from "@novaclaw/core/jh/tools-basic"

const atom = JSON.stringify({
  goal: "leaf",
  size: "atomic",
  tool: "note",
  args: { text: "x" },
  success: "ok",
  check: { type: "artifact_present" },
  produces: [{ id: "out", type: "note" }],
})

interface Spy {
  readonly thinkPrompts: JhExpander.PromptPair[]
  readonly doPrompts: JhExpander.PromptPair[]
}

function deps(think: ((p: JhExpander.PromptPair) => Effect.Effect<string, JhEngine.LLMFail>) | undefined, spy: Spy, over: Partial<JhEngine.Deps> = {}): JhEngine.Deps {
  return {
    introspect: (p) => {
      spy.doPrompts.push(p)
      return Effect.succeed(atom)
    },
    correct: () => Effect.succeed(atom),
    ...(think ? { think: (p: JhExpander.PromptPair) => { spy.thinkPrompts.push(p); return think(p) } } : {}),
    // The declared produce must actually arrive, or `artifact_present` can never pass and every run
    // blocks on budget regardless of the think stage (fixture bug, not engine behaviour).
    executor: { run: () => Effect.succeed({ ok: true, output: "o", artifacts: new Map([["out", "x"]]) }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    limits: { maxDepth: 2, maxTotalSteps: 6 },
    trigger: JhBudget.DEFAULT_TRIGGER,
    ...over,
  }
}
const run = (d: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(d, { goal: "the task" }))
const spy = (): Spy => ({ thinkPrompts: [], doPrompts: [] })

describe("JhEngine think/do split (improve19)", () => {
  test("no `think` dep = today's behaviour exactly (the seam is opt-in)", async () => {
    const s = spy()
    const r = await run(deps(undefined, s))
    expect(s.thinkPrompts).toHaveLength(0)
    expect(r.status).toBe("done")
    expect(r.state.log.some((e) => e.type === "planned")).toBe(false)
  })

  test("the plan reaches the DO call, and the THINK call is schema-FREE", async () => {
    const s = spy()
    await run(deps(() => Effect.succeed("1. write the file\n2. check it compiles"), s))
    expect(s.thinkPrompts.length).toBeGreaterThan(0)
    // The think prompt must NOT ask for JSON — that is the entire point of the split.
    const t = s.thinkPrompts[0]
    expect(t.system).toContain("no JSON")
    expect(t.system).not.toContain('"size"')
    // …and the plan must arrive in the DO call's context.
    expect(s.doPrompts.some((p) => p.user.includes("write the file") && p.user.includes("YOUR PLAN FOR THIS STEP"))).toBe(true)
  })

  test("the plan is an ARTIFACT: `planned` is logged verbatim, not hidden", async () => {
    const s = spy()
    const r = await run(deps(() => Effect.succeed("do the thing carefully"), s))
    const planned = r.state.log.find((e) => e.type === "planned")
    expect(planned).toBeDefined()
    expect((planned as { plan: string }).plan).toContain("do the thing carefully")
  })

  test("a FAILED think never costs the step (the improve1 ghost, caught)", async () => {
    const s = spy()
    const r = await run(deps(() => Effect.fail({ message: "llm down" }), s))
    expect(r.status).toBe("done") // the run completes unplanned
    expect(r.state.log.some((e) => e.type === "think_failed" && (e as { reason: string }).reason === "llm_unreachable")).toBe(true)
    expect(s.doPrompts.some((p) => p.user.includes("YOUR PLAN FOR THIS STEP"))).toBe(false)
  })

  test("an EMPTY/runaway think (wave-1's exact failure) falls through, does not block", async () => {
    const s = spy()
    // `<think>` ate the whole budget → empty content. Wave 1 disabled thinking because of this.
    const r = await run(deps(() => Effect.succeed("   \n  \n"), s))
    expect(r.status).toBe("done")
    expect(r.state.log.some((e) => e.type === "think_failed" && (e as { reason: string }).reason === "empty")).toBe(true)
  })

  test("`thinkOn` narrows the stage to the expensive nodes only", async () => {
    const s = spy()
    await run(deps(() => Effect.succeed("plan"), s, { thinkOn: ["recover"] }))
    // Nothing fails in this fixture, so a recover-only filter must never fire.
    expect(s.thinkPrompts).toHaveLength(0)
  })

  test("boundPlan enforces the bounded ASK (summarisation without a third call)", () => {
    const long = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n")
    expect(JhExpander.boundPlan(long).split("\n")).toHaveLength(JhExpander.PLAN_MAX_LINES)
    // Code fences are stripped: the DO call must never receive something to copy as a schema.
    expect(JhExpander.boundPlan('do it\n```json\n{"size":"atomic"}\n```\nthen check')).not.toContain("size")
    expect(JhExpander.boundPlan("   \n \n")).toBe("")
  })
})
