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

// The evidence rule applies ONLY at the ROOT whole-task goal-check. This harness forces the root to
// decompose into one child with a STRONG (run) check — so the child commits with NO weak-leaf goal-check —
// then the root-completion gate runs the (evidence-gated) LLM goal-check. No taskComplete, so the LLM
// fallback fires. The single goal-check reply is unambiguously the root's.
function rootGcHarness(opts: { rootGoalCheck: string; files: () => Array<{ name: string; content: string }>; evidence?: boolean }) {
  const steps = [
    atom({ goal: "whole task", produces: [] }), // root atomic → triggers the soft-decompose
    JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: [{ goal: "run it", size: "atomic", tool: "run", args: { command: "x" }, success: "ok", check: { type: "run", command: "x" }, produces: [] }] }),
    atom({ goal: "run it", tool: "run", args: { command: "x" }, check: { type: "run", command: "x" }, produces: [] }), // child introspect
  ]
  let i = 0
  let rootGc = 0
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      if (p.user.includes("Is the goal fully achieved?")) {
        rootGc++
        return Effect.succeed(opts.rootGoalCheck)
      }
      return Effect.succeed(steps[i++] ?? atom())
    },
    correct: () => Effect.fail({ message: "no correct" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "ran", artifacts: new Map<string, string>() }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: opts.files,
    forceRootDecompose: true,
    verifyGoal: true,
    evidence: opts.evidence,
    limits: { maxDepth: 2, maxTotalSteps: 16 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, rootGcCalls: () => rootGc }
}
const runRoot = (h: ReturnType<typeof rootGcHarness>) => Effect.runPromise(JhEngine.runTask(h.deps, { goal: "the task" }))

describe("R2 goal-check evidence rule (root-only)", () => {
  test("the WEAK-LEAF never applies evidence: achieved:true with no quote commits even when evidence is ON", async () => {
    // a weak model can't verbatim-quote per step; the per-step goal-check must NOT demand it (run42/43 fix)
    const h = gcHarness({ step: atom(), goalCheck: `{"achieved": true, "missing": ""}`, files: () => [{ name: "a", content: "x" }], evidence: true })
    expect((await run(h)).status).toBe("done")
  })

  test("ROOT evidence-verified whole-task success commits (the quote occurs in the workspace)", async () => {
    const h = rootGcHarness({
      rootGoalCheck: `{"achieved": true, "missing": "", "evidence": "proof-quote-42"}`,
      files: () => [{ name: "out.txt", content: "RESULT proof-quote-42 done" }],
      evidence: true,
    })
    expect((await runRoot(h)).status).toBe("done")
  })

  test("ROOT fabricated evidence is REJECTED — no false DONE (rubber-stamp guard)", async () => {
    const h = rootGcHarness({
      rootGoalCheck: `{"achieved": true, "missing": "", "evidence": "NONEXISTENT-QUOTE"}`,
      files: () => [{ name: "out.txt", content: "the real workspace content" }],
      evidence: true,
    })
    const r = await runRoot(h)
    expect(r.status).not.toBe("done") // the unverifiable claim did not commit the whole task
    expect(detailIncludes(r, "without verifiable evidence")).toBeGreaterThan(0)
  })

  test("ROOT evidence OFF: achieved:true with no quote is accepted (pre-R2 behavior)", async () => {
    const h = rootGcHarness({ rootGoalCheck: `{"achieved": true, "missing": ""}`, files: () => [{ name: "a", content: "x" }], evidence: false })
    expect((await runRoot(h)).status).toBe("done")
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
