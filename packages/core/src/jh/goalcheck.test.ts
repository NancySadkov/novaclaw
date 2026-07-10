import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import { JhEngine } from "./engine"

// R2 (jh-improve1 P2) engine tests: the goal-check CACHE + EVIDENCE rule. A single atomic-root leaf with a
// weak (artifact_present) check under verifyGoal fires the weak-leaf goal-check; the harness distinguishes a
// goal-check LLM call from a step introspect by the prompt text, and counts them.
const atom = (over: Record<string, unknown> = {}) => JSON.stringify({ goal: "leaf", size: "atomic", tool: "note", args: { text: "x" }, success: "ok", check: { type: "artifact_present" }, produces: [], ...over })

function gcHarness(opts: {
  step: string | (() => string)
  goalCheck: string | (() => string)
  files: () => Array<{ name: string; content: string }>
  evidence?: boolean
  goalCheckCache?: boolean
  limits?: { maxDepth: number; maxTotalSteps: number }
}) {
  let goalCheckCalls = 0
  let stepCalls = 0
  const nextOf = (r: string | (() => string)) => (typeof r === "function" ? r() : r)
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      if (p.user.includes("Is the goal fully achieved?")) {
        goalCheckCalls++
        return Effect.succeed(nextOf(opts.goalCheck))
      }
      stepCalls++
      return Effect.succeed(nextOf(opts.step))
    },
    correct: () => Effect.fail({ message: "no correct" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "o", artifacts: new Map<string, string>() }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: opts.files,
    verifyGoal: true,
    goalCheckCache: opts.goalCheckCache,
    evidence: opts.evidence,
    limits: opts.limits ?? { maxDepth: 0, maxTotalSteps: 16 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, goalCheckCalls: () => goalCheckCalls, stepCalls: () => stepCalls }
}
const run = (h: ReturnType<typeof gcHarness>) => Effect.runPromise(JhEngine.runTask(h.deps, { goal: "the task" }))
const detailIncludes = (r: JhEngine.Report, s: string) => r.state.log.filter((e) => e.type === "verification" && String((e as { detail?: unknown }).detail).includes(s)).length

describe("R2 goal-check evidence rule", () => {
  test("evidence-verified success commits (the quote occurs in the workspace)", async () => {
    const h = gcHarness({
      step: atom(),
      goalCheck: `{"achieved": true, "missing": "", "evidence": "PROOF123"}`,
      files: () => [{ name: "pi.c", content: "complete source PROOF123 here" }],
      evidence: true,
    })
    const r = await run(h)
    expect(r.status).toBe("done") // the verbatim quote proves it → committed
  })

  test("fabricated evidence is demoted and NEVER accrues toward stuck (checker fault, not model fault)", async () => {
    const h = gcHarness({
      step: atom(),
      goalCheck: `{"achieved": true, "missing": "", "evidence": "NONEXISTENT-QUOTE-XYZ"}`,
      files: () => [{ name: "pi.c", content: "some real source" }],
      evidence: true,
      goalCheckCache: false, // fresh fabricated check each iteration
    })
    const r = await run(h)
    // the demote fires many times (ran to the explore cap), never stopping early on a manufactured "stuck"
    expect(detailIncludes(r, "goal-check claimed success without verifiable evidence")).toBeGreaterThan(3)
    expect(r.status).toBe("blocked")
  })

  test("evidence OFF (flags-off parity): achieved:true with NO evidence still commits (pre-R2 behavior)", async () => {
    const off = gcHarness({ step: atom(), goalCheck: `{"achieved": true, "missing": ""}`, files: () => [{ name: "a", content: "x" }], evidence: false })
    expect((await run(off)).status).toBe("done")
    // and with evidence ON the same reply is demoted (never done)
    const on = gcHarness({ step: atom(), goalCheck: `{"achieved": true, "missing": ""}`, files: () => [{ name: "a", content: "x" }], evidence: true })
    expect((await run(on)).status).not.toBe("done")
  })
})

describe("R2 goal-check cache", () => {
  test("an unchanged state reuses the verdict — ONE LLM goal-check across many iterations", async () => {
    const h = gcHarness({
      step: atom(),
      goalCheck: `{"achieved": false, "missing": "not yet"}`,
      files: () => [{ name: "a", content: "x" }], // fixed workspace, no run output → identical key every time
      goalCheckCache: true,
      evidence: false,
    })
    const r = await run(h)
    expect(h.goalCheckCalls()).toBe(1) // cached after the first; the rest cost no LLM call
    expect(detailIncludes(r, "cached — state unchanged")).toBeGreaterThan(0) // the transcript shows the cache working
    expect(r.status).toBe("blocked") // the cached repeats still count toward stuck
  })

  test("a state change INVALIDATES the cache — a fresh goal-check per changed workspace", async () => {
    let tick = 0
    const h = gcHarness({
      step: () => { tick++; return atom() }, // each iteration mutates the workspace
      goalCheck: `{"achieved": false, "missing": "no"}`,
      files: () => [{ name: "a", content: `state ${tick}` }],
      goalCheckCache: true,
      evidence: false,
    })
    const r = await run(h)
    expect(h.goalCheckCalls()).toBeGreaterThan(1) // changing state ⇒ no cache reuse
    void r
  })

  test("cache OFF: every goal-check hits the LLM even on an unchanged state", async () => {
    const h = gcHarness({
      step: atom(),
      goalCheck: `{"achieved": false, "missing": "no"}`,
      files: () => [{ name: "a", content: "x" }],
      goalCheckCache: false,
      evidence: false,
    })
    await run(h)
    expect(h.goalCheckCalls()).toBeGreaterThan(1) // no caching → repeated LLM calls
  })
})
