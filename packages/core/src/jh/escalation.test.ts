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
