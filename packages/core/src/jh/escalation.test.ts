import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// R3/R4 (jh-improve1 P4/P5) engine integration: graded score + keep-best, and the escalation ladder's
// forced-analyze stage. The root decomposes into one child (run check) and the whole-task oracle keeps
// failing, so the root grows fix nodes and the ladder escalates tweak×3 → analyze.
const atomObj = (over: Record<string, unknown> = {}) => JSON.stringify({ goal: "step", size: "atomic", tool: "run", args: { command: "go" }, success: "ok", check: { type: "run", command: "go" }, produces: [], ...over })
const compound1 = () => JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: [{ goal: "child", size: "atomic", tool: "run", args: { command: "go" }, success: "ok", check: { type: "run", command: "go" }, produces: [] }] })

function escHarness(opts: {
  world: (command: string) => { exitCode: number; output: string }
  taskComplete: JhEngine.Deps["taskComplete"]
  ladder?: boolean
  keepBest?: boolean
  forcedAnalyze?: boolean
  files?: () => Array<{ name: string; content: string }>
}) {
  let calls = 0
  const runner: JhProcessRunner.Runner = { run: ({ command }) => Effect.succeed({ ...opts.world(command), timedOut: false }) }
  const deps: JhEngine.Deps = {
    introspect: () => {
      calls++
      return Effect.succeed(calls === 2 ? compound1() : atomObj()) // call 1 root-atomic → soft-decompose → call 2 compound; rest = run atoms
    },
    correct: () => Effect.fail({ message: "x" }),
    executor: {
      run: ({ tool, args }) => {
        if (tool === "run") {
          const r = opts.world(String(args.command))
          return Effect.succeed({ ok: r.exitCode === 0, output: r.output, artifacts: new Map<string, string>() })
        }
        return Effect.succeed({ ok: true, output: "n", artifacts: new Map<string, string>() })
      },
    },
    runner,
    artifacts: JhArtifact.memory(),
    fileExists: () => true,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: opts.files ?? (() => [{ name: "pi.c", content: "source" }]),
    forceRootDecompose: true,
    verifyGoal: true,
    taskComplete: opts.taskComplete,
    ladder: opts.ladder,
    keepBest: opts.keepBest,
    forcedAnalyze: opts.forcedAnalyze,
    limits: { maxDepth: 2, maxTotalSteps: 24 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps }
}
const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "the whole task" }))
const has = (r: JhEngine.Report, t: string) => r.state.log.some((e) => e.type === t)
const verifDetail = (r: JhEngine.Report, s: string) => r.state.log.some((e) => e.type === "verification" && String((e as { detail?: unknown }).detail ?? "").includes(s))

describe("R4 escalation ladder — forced analyze", () => {
  test("the ladder reaches the analyze stage; an analyze node with NO NAME=value output is demoted", async () => {
    // the oracle never accepts (stable sig, ungraded) → the root grows fix nodes; at the 4th the ladder is at
    // "analyze"; the run prints no labeled values → the forced-analyze gate demotes it.
    const { deps } = escHarness({
      world: () => ({ exitCode: 0, output: "some plain output with no labeled values at all" }),
      taskComplete: () => ({ done: false, detail: "the result is wrong" }), // ungraded, stable → ladder advances on count
      ladder: true,
    })
    const r = await run(deps)
    expect(verifDetail(r, "no labeled intermediate values")).toBe(true) // the analyze gate fired
    expect(r.status).toBe("blocked") // never done (the oracle is always negative)
  })

  test("an analyze node WITH >=3 NAME=value lines is NOT demoted by the forced-analyze gate", async () => {
    const { deps } = escHarness({
      world: () => ({ exitCode: 0, output: "iter=5\nsum=3.20\nterm=0.0001\nrunning..." }), // 3 labeled values
      taskComplete: () => ({ done: false, detail: "the result is wrong" }),
      ladder: true,
    })
    const r = await run(deps)
    expect(verifDetail(r, "no labeled intermediate values")).toBe(false) // instrumentation present → gate passes
  })

  test("forcedAnalyze:false (PROSE task) — the analyze stage never demands NAME=value; no instrumentation hard-block", async () => {
    // wave-21 residue: a prose/writing task has no numeric intermediates, so the forced-instrumentation
    // demotion ("no labeled intermediate values… add the printf") would hard-block it forever (novel run76
    // relocated onto it after its self-copy was refused). With forcedAnalyze:false the ladder still
    // escalates (grows fix nodes, cycles) but the analyze node is not marked instrumented, so the gate
    // never fires — the analyze stage instead asks for a task-agnostic diagnosis.
    const { deps } = escHarness({
      world: () => ({ exitCode: 0, output: "a paragraph of prose with no labeled values at all" }),
      taskComplete: () => ({ done: false, detail: "a chapter is wrong" }), // ungraded, stable → ladder advances
      ladder: true,
      forcedAnalyze: false,
    })
    const r = await run(deps)
    expect(verifDetail(r, "no labeled intermediate values")).toBe(false) // the code-only demotion never fires
    expect(has(r, "expanded")).toBe(true) // the ladder DID escalate (grew fix nodes)
    expect(r.status).toBe("blocked") // still never done (the oracle is always negative), just not hard-blocked on printf
  })

  test("flags-off: ladder:false never emits the analyze directive (legacy latch)", async () => {
    const { deps } = escHarness({
      world: () => ({ exitCode: 0, output: "plain output no labels" }),
      taskComplete: () => ({ done: false, detail: "wrong" }),
      ladder: false,
    })
    const r = await run(deps)
    expect(verifDetail(r, "no labeled intermediate values")).toBe(false) // no analyze stage exists with the ladder off
  })
})

describe("D11/D12 never-dead-end robustness (from the char campaign)", () => {
  test("D12: an ATOMIC root cannot commit-done unless taskComplete agrees (no false-done)", async () => {
    // the model insists the root is atomic (soft-decompose always fails) → the root runs as one leaf whose
    // check passes, but taskComplete says NOT done → the root must NOT false-commit (char run46).
    const deps: JhEngine.Deps = {
      introspect: () => Effect.succeed(atomObj()), // always atomic → soft-decompose fails → root runs atomic
      correct: () => Effect.fail({ message: "x" }),
      executor: { run: () => Effect.succeed({ ok: true, output: "wrong", artifacts: new Map<string, string>() }) },
      runner: { run: () => Effect.succeed({ exitCode: 0, output: "wrong", timedOut: false }) }, // the run check passes
      artifacts: JhArtifact.memory(),
      fileExists: () => true,
      cwd: ".",
      toolNames: JhBasicTools.TOOL_NAMES,
      listFiles: () => [{ name: "a.c", content: "src" }],
      forceRootDecompose: true,
      verifyGoal: true,
      taskComplete: () => ({ done: false, detail: "not the right output" }),
      limits: { maxDepth: 0, maxTotalSteps: 8 },
      trigger: JhBudget.DEFAULT_TRIGGER,
    }
    const r = await run(deps)
    expect(r.status).not.toBe("done") // the precise oracle gated the atomic-root commit
  })

  test("D11: a non-root unparseable introspection RECOVERS (grows a fix sibling) instead of cascade-blocking", async () => {
    // root → 1 child; the child's introspection is garbage twice → best-effort-commit + grow a fix sibling,
    // never a hard `unparseable` block that discards the whole run (char run45's 85-digit near-miss).
    const steps = [atomObj({ goal: "root" }), compound1(), "total garbage not json", "still not json", atomObj({ goal: "fix" })]
    let i = 0
    const deps: JhEngine.Deps = {
      introspect: (p) => (p.user.includes("Is the goal fully achieved?") ? Effect.succeed(`{"achieved": false}`) : Effect.succeed(steps[i++] ?? atomObj())),
      correct: () => Effect.fail({ message: "x" }),
      executor: { run: () => Effect.succeed({ ok: true, output: "ran", artifacts: new Map<string, string>() }) },
      runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
      artifacts: JhArtifact.memory(),
      fileExists: () => true,
      cwd: ".",
      toolNames: JhBasicTools.TOOL_NAMES,
      listFiles: () => [{ name: "a.c", content: "src" }],
      forceRootDecompose: true,
      verifyGoal: true,
      taskComplete: () => ({ done: false, detail: "wrong" }),
      limits: { maxDepth: 2, maxTotalSteps: 12 },
      trigger: JhBudget.DEFAULT_TRIGGER,
    }
    const r = await run(deps)
    expect(has(r, "committed_best_effort")).toBe(true) // the garbage child was recovered, not hard-blocked
    expect(r.reason).not.toBe("unparseable") // never a cascade-block on the parse failure
  })

  test("D11 parity: with verifyGoal OFF, an unparseable node still hard-blocks (unchanged legacy behavior)", async () => {
    const steps = [compound1(), "garbage", "garbage"] // root decomposes → child introspects garbage twice
    let i = 0
    const deps: JhEngine.Deps = {
      introspect: () => Effect.succeed(steps[i++] ?? "garbage"),
      correct: () => Effect.fail({ message: "x" }),
      executor: { run: () => Effect.succeed({ ok: true, output: "", artifacts: new Map<string, string>() }) },
      runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
      artifacts: JhArtifact.memory(),
      fileExists: () => true,
      cwd: ".",
      toolNames: JhBasicTools.TOOL_NAMES,
      forceRootDecompose: false,
      verifyGoal: false, // OFF → legacy hard-block
      limits: { maxDepth: 2, maxTotalSteps: 12 },
      trigger: JhBudget.DEFAULT_TRIGGER,
    }
    const r = await run(deps)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("unparseable")
  })
})

describe("R3 graded score + keep-best", () => {
  test("a new best score emits `scored`; a snapshot is kept", async () => {
    // score climbs from the run output: 0.2 then 0.6 then never done → two `scored` events (improvements only)
    let n = 0
    const outputs = ["progress-0.2", "progress-0.6", "progress-0.6"]
    const { deps } = escHarness({
      world: () => ({ exitCode: 0, output: outputs[Math.min(n++, outputs.length - 1)]! }),
      taskComplete: (i) => {
        const score = i.lastOutput.includes("0.6") ? 0.6 : i.lastOutput.includes("0.2") ? 0.2 : 0
        return { done: false, detail: "not yet", score }
      },
      keepBest: true,
    })
    const r = await run(deps)
    const scores = r.state.log.filter((e) => e.type === "scored").map((e) => (e as { score: number }).score)
    expect(scores.length).toBeGreaterThanOrEqual(1) // at least one improvement recorded
    expect(Math.max(...scores)).toBeGreaterThanOrEqual(0.2)
    expect(scores).toEqual([...scores].sort((a, b) => a - b)) // monotonic — only improvements are logged
  })
})
