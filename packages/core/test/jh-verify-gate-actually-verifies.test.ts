import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "../src/jh/artifact"
import { JhBudget } from "../src/jh/budget"
import { JhBasicTools } from "../src/jh/tools-basic"
import { JhEngine } from "../src/jh/engine"
import { JhVerifier } from "../src/jh/verifier"

// Three invariants of the jh verify gate — all of them the gate actually VERIFYING, which is the whole
// reason a deterministic controller is wrapped around a stochastic proposer:
//
//  1. A CHECK WITH NOTHING TO CHECK IS NOT A PASS. `artifact_present` — the check the engine SUBSTITUTES
//     when the model omits one — asks "was every declared product committed?". Over a step that declared
//     no products that is vacuously true, so the default gate for the least-specified step in a run
//     could not fail. A vacuous check is worse than no check, because the step reports VERIFIED.
//  2. THE STRONGEST GATE MUST BE THE STRICTEST. `output_equals` outranks `run` (a step's check may only
//     be swapped for one that ranks at least as high), yet `run` failed a non-zero exit and
//     `output_equals` did not — so a program that printed the right answer and then crashed passed the
//     one check the engine trusts most.
//  3. THE GATE'S OWN RUN IS A RUN. The verify gate re-runs the program; "the most recent program output"
//     was captured only from the MODEL's `run` action, so every judge that reads it — the recovery
//     context, the completion oracle, the forced-analyze instrumentation gate — graded a stale stdout.

// ── a minimal engine world: one scripted model, one scripted shell ─────────────────────────────────
const atom = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    goal: "leaf",
    size: "atomic",
    tool: "note",
    args: { text: "x" },
    success: "ok",
    check: { type: "artifact_present" },
    produces: [],
    ...over,
  })

function probe(opts: {
  /** model replies, in order; the last one repeats once the queue is dry (the recovery loop needs one) */
  readonly steps: ReadonlyArray<string>
  /** what the SHELL prints — this is the verify gate's own run, never the model's action */
  readonly shell?: (command: string) => { exitCode: number; output: string }
  /** what the EXECUTOR prints — this is the model's own `run` action */
  readonly actionOutput?: string
  /** artifact ids the executor commits, with content */
  readonly artifacts?: Record<string, string>
  readonly verifyGoal?: boolean
  readonly goalAchieved?: boolean
  readonly taskComplete?: JhEngine.Deps["taskComplete"]
  readonly maxTotalSteps?: number
  readonly maxDepth?: number
}) {
  const prompts: string[] = []
  /** every `lastOutput` the caller's completion oracle was handed, in order */
  const oracleSaw: string[] = []
  let i = 0
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      prompts.push(p.user)
      if (p.user.includes("Is the goal fully achieved?"))
        return Effect.succeed(JSON.stringify({ achieved: opts.goalAchieved ?? false, missing: "not verified" }))
      return Effect.succeed(opts.steps[i++] ?? opts.steps[opts.steps.length - 1] ?? atom())
    },
    executor: {
      run: () =>
        Effect.succeed({
          ok: true,
          output: opts.actionOutput ?? "o",
          artifacts: new Map(Object.entries(opts.artifacts ?? {})),
        }),
    },
    runner: {
      run: ({ command }) => {
        const r = opts.shell?.(command) ?? { exitCode: 0, output: "" }
        return Effect.succeed({ exitCode: r.exitCode, output: r.output, timedOut: false })
      },
    },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    ...(opts.verifyGoal === undefined ? {} : { verifyGoal: opts.verifyGoal }),
    ...(opts.taskComplete === undefined
      ? {}
      : {
          taskComplete: (input: { workspace: string; lastOutput: string }) => {
            oracleSaw.push(input.lastOutput)
            return opts.taskComplete!(input)
          },
        }),
    limits: { maxDepth: opts.maxDepth ?? 0, maxTotalSteps: opts.maxTotalSteps ?? 4 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, prompts, oracleSaw }
}
const run = (p: ReturnType<typeof probe>) => Effect.runPromise(JhEngine.runTask(p.deps, { goal: "the task" }))
const details = (r: JhEngine.Report): string[] =>
  r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail))
const committed = (r: JhEngine.Report): boolean => r.state.log.some((e) => e.type === "committed")

// ── 1. a check with nothing to check is not a pass ─────────────────────────────────────────────────
describe("`artifact_present` over a step that declared no `produces` never reports the step verified", () => {
  test("🔴 the step is REFUSED as unverifiable — not passed, and not blamed for a failure we never saw", async () => {
    const p = probe({ steps: [atom()] }) // produces: [] — nothing to check, and no goal checker to fall back on
    const r = await run(p)
    console.log(`[vacuous] status=${r.status} committed=${committed(r)} verdicts=${JSON.stringify(details(r))}`)
    expect(committed(r)).toBe(false)
    expect(r.status).not.toBe("done")
    // It names OUR instrument as the fault and tells the model how to make the step checkable…
    expect(details(r).some((d) => d.includes("NOTHING to check"))).toBe(true)
    expect(details(r).some((d) => d.includes("declare in `produces`"))).toBe(true)
    // …and never asserts an absence it did not witness (the `file_exists` audit's rule, same gate).
    expect(details(r).some((d) => d.includes("missing or empty"))).toBe(false)
  })

  test("the control: the SAME step WITH a declared produce that IS there still passes", async () => {
    const p = probe({
      steps: [atom({ produces: [{ id: "out", type: "note" }] })],
      artifacts: { out: "the artifact" },
    })
    const r = await run(p)
    console.log(`[vacuous] control-present status=${r.status} committed=${committed(r)}`)
    expect(committed(r)).toBe(true)
    expect(r.status).toBe("done")
  })

  test("the control: a declared produce that is MISSING still fails, and still says so plainly", async () => {
    const p = probe({ steps: [atom({ produces: [{ id: "out", type: "note" }] })], artifacts: {} })
    const r = await run(p)
    console.log(`[vacuous] control-missing status=${r.status} verdicts=${JSON.stringify(details(r))}`)
    expect(committed(r)).toBe(false)
    expect(details(r).some((d) => d.includes("declared produces missing or empty"))).toBe(true)
  })

  test("a real verifier can still certify it: the goal check reads the WORKSPACE, and its verdict decides", async () => {
    // The refusal is about the MECHANICAL gate having no evidence, not about the step being wrong. With a
    // goal checker configured (production always is — `session/runner/strict.ts`) the step is judged by
    // something that can actually look, and both of its answers are honored.
    const yes = await run(probe({ steps: [atom()], verifyGoal: true, goalAchieved: true, maxTotalSteps: 6 }))
    const no = await run(probe({ steps: [atom()], verifyGoal: true, goalAchieved: false, maxTotalSteps: 6 }))
    console.log(`[vacuous] goal-check achieved → ${yes.status}; NOT achieved → ${no.status}`)
    expect(committed(yes)).toBe(true)
    expect(committed(no)).toBe(false)
  })
})

// ── 2. the highest-ranked check must be the strictest ──────────────────────────────────────────────
describe("`output_equals` fails a program that prints the right answer and then crashes", () => {
  const oe = atom({
    tool: "run",
    args: { command: "./p" },
    check: { type: "output_equals", command: "./p", expected: "42" },
  })

  test("🔴 the expected output with a NON-ZERO exit does not pass the strongest gate", async () => {
    const p = probe({ steps: [oe], shell: () => ({ exitCode: 3, output: "42" }) })
    const r = await run(p)
    console.log(`[output_equals] crash status=${r.status} verdicts=${JSON.stringify(details(r))}`)
    expect(committed(r)).toBe(false)
    expect(r.status).not.toBe("done")
    // The verdict must name the CRASH, not report a text mismatch on text that matched.
    expect(details(r).some((d) => d.includes("exited 3"))).toBe(true)
    expect(details(r).some((d) => d.includes("expected 42, got 42"))).toBe(false)
  })

  test("the control: the SAME output with exit 0 still passes — the check is fixed, not broken", async () => {
    const p = probe({ steps: [oe], shell: () => ({ exitCode: 0, output: "42" }) })
    const r = await run(p)
    console.log(`[output_equals] control status=${r.status} committed=${committed(r)}`)
    expect(committed(r)).toBe(true)
    expect(r.status).toBe("done")
  })

  test("the neighbour it was measured against: `run` has always failed a non-zero exit", async () => {
    // The pattern is "the gate reads the text but not the program's own verdict on whether it produced
    // that text"; `run` one case up in the same switch was the control that made it a defect, not a design.
    const crash = { exitCode: 3, output: "42" }
    const asRun = await Effect.runPromise(
      JhVerifier.verify({
        check: { type: "run", command: "./p" },
        cwd: ".",
        runner: { run: () => Effect.succeed({ ...crash, timedOut: false }) },
        fileExists: () => false,
        produced: "none_declared",
      }),
    )
    const asOutputEquals = await Effect.runPromise(
      JhVerifier.verify({
        check: { type: "output_equals", command: "./p", expected: "42" },
        cwd: ".",
        runner: { run: () => Effect.succeed({ ...crash, timedOut: false }) },
        fileExists: () => false,
        produced: "none_declared",
      }),
    )
    console.log(`[output_equals] run.ok=${asRun.ok} output_equals.ok=${asOutputEquals.ok}`)
    expect(asRun.ok).toBe(false)
    expect(asOutputEquals.ok).toBe(false) // the strictly stronger check may never be the more permissive one
  })
})

// ── 3. the gate's own run is a run ─────────────────────────────────────────────────────────────────
describe("after the verify gate runs the program, the judges read THAT output, not the earlier action's", () => {
  // Two DIFFERENT outputs, so a stale read is observable: asserting one value both paths produce would
  // prove nothing. The model's `run` action prints ACTION-OUT; the gate's own run prints GATE-OUT.
  const ACTION = "ACTION-OUT-aaa"
  const GATE = "GATE-OUT-bbb"

  test("🔴 the recovery context the model reads next carries the GATE's output", async () => {
    const p = probe({
      steps: [atom({ tool: "run", args: { command: "./p" }, check: { type: "run", command: "./p", expect: "ZZZ" } })],
      actionOutput: ACTION,
      shell: () => ({ exitCode: 0, output: GATE }), // the gate re-runs it; `expect` misses → recovery
      maxTotalSteps: 3,
    })
    await run(p)
    const withOutputBlock = p.prompts.filter((s) => s.includes("# Most recent program output"))
    console.log(
      `[stale-stdout] ${withOutputBlock.length} prompt(s) carried an output block; ` +
        `GATE in ${withOutputBlock.filter((s) => s.includes(GATE)).length}, ` +
        `ACTION in ${withOutputBlock.filter((s) => s.includes(ACTION)).length}`,
    )
    // The control that this asserts a real path: the block fired at all.
    expect(withOutputBlock.length).toBeGreaterThan(0)
    expect(withOutputBlock.some((s) => s.includes(GATE))).toBe(true)
    expect(withOutputBlock.every((s) => !s.includes(ACTION))).toBe(true)
  })

  test("🔴 the completion oracle judges the GATE's output — and the run's own status turns on it", async () => {
    // The oracle only calls the task done when it is shown the output the gate actually produced, so a
    // stale read is not merely visible in a log line: it changes the verdict of the whole run.
    const p = probe({
      steps: [
        atom({ goal: "whole task" }), // atomic root + an oracle → soft-decompose
        JSON.stringify({
          goal: "root",
          size: "needs_decomposition",
          success: "ok",
          substeps: [
            {
              goal: "run it",
              size: "atomic",
              tool: "run",
              args: { command: "./p" },
              success: "ok",
              check: { type: "run", command: "./p" },
              produces: [],
            },
          ],
        }),
        atom({ goal: "run it", tool: "run", args: { command: "./p" }, check: { type: "run", command: "./p" } }),
      ],
      actionOutput: ACTION,
      shell: () => ({ exitCode: 0, output: GATE }),
      taskComplete: ({ lastOutput }) => ({ done: lastOutput.includes(GATE), detail: `oracle saw: ${lastOutput}` }),
      maxDepth: 2,
      maxTotalSteps: 6,
    })
    const r = await run(p)
    console.log(`[stale-stdout] oracle was handed ${JSON.stringify(p.oracleSaw)}; status=${r.status}`)
    expect(p.oracleSaw.length).toBeGreaterThan(0) // the oracle really was consulted
    expect(p.oracleSaw.includes(ACTION)).toBe(true) // …on BOTH paths, so the two are distinguishable
    expect(p.oracleSaw.includes(GATE)).toBe(true)
    expect(p.oracleSaw[p.oracleSaw.length - 1]).toBe(GATE) // the LAST word is the freshest run's
    expect(r.status).toBe("done")
  })
})
