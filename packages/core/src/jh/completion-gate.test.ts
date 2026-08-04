import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import { JhEngine } from "./engine"

// v0.2.0 — THE COMPLETION GATE. jh.md §14.1's design law: push everything checkable out of the
// model's head into executed mechanical checks, and treat what remains — judge calls,
// self-assessments — as fallible input, NEVER as ground truth. Without a `taskComplete` oracle the
// whole-task authority was `verifyGoal`'s LLM goal-check, i.e. the model grading its own homework, and
// `session/runner/strict.ts` supplies no oracle (it cannot: an exact oracle needs the expected answer).
// `Deps.completionGate` is the injected MECHANICAL veto. These tests pin, in both directions:
//   1. a red gate cannot be talked past — no path reports `done`;
//   2. it is BOUNDED — the verifier runs at most `completionGateChecks` times per run, and running out
//      of budget REFUSES (ruling 2: "not verified" is the honest answer, never "complete");
//   3. an absent gate leaves the engine byte-identical to before.
//
// Shape borrowed from goalcheck.test.ts's `rootGcHarness`: an atomic root reply triggers the forced
// soft-decompose, the single child carries a STRONG (run) check so it commits without a per-step
// goal-check, and the root-completion gate then runs the LLM whole-task check — the exact production
// Strict configuration (`forceRootDecompose` + `verifyGoal`, no oracle).

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

interface GateOpts {
  /** verdicts the gate returns, in order; the last one repeats. */
  readonly gate?: ReadonlyArray<boolean>
  readonly checks?: number
  readonly taskComplete?: JhEngine.Deps["taskComplete"]
  /** omit the gate entirely — the pre-v0.2.0 engine. */
  readonly noGate?: boolean
  readonly goalCheck?: string
}

function harness(opts: GateOpts) {
  const steps = [
    atom({ goal: "whole task" }), // root replies atomic → forced soft-decompose
    JSON.stringify({
      goal: "root",
      size: "needs_decomposition",
      success: "ok",
      substeps: [
        {
          goal: "run it",
          size: "atomic",
          tool: "run",
          args: { command: "x" },
          success: "ok",
          check: { type: "run", command: "x" },
          produces: [],
        },
      ],
    }),
    atom({ goal: "run it", tool: "run", args: { command: "x" }, check: { type: "run", command: "x" }, produces: [] }),
  ]
  let i = 0
  let gateCalls = 0
  const prompts: string[] = []
  const verdicts = opts.gate ?? [false]
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      prompts.push(p.user)
      return p.user.includes("Is the goal fully achieved?")
        ? Effect.succeed(opts.goalCheck ?? `{"achieved": true, "missing": "", "evidence": "PROOF"}`)
        : Effect.succeed(steps[i++] ?? atom())
    },
    correct: () => Effect.fail({ message: "no correct" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "ran", artifacts: new Map<string, string>() }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: () => [{ name: "out.txt", content: "RESULT PROOF done" }],
    forceRootDecompose: true,
    verifyGoal: true,
    ...(opts.taskComplete === undefined ? {} : { taskComplete: opts.taskComplete }),
    ...(opts.noGate === true
      ? {}
      : {
          completionGate: () =>
            Effect.sync(() => {
              const ok = verdicts[Math.min(gateCalls, verdicts.length - 1)]!
              gateCalls++
              return { ok, detail: ok ? "checks pass" : "the test command failed with exit 1" }
            }),
        }),
    ...(opts.checks === undefined ? {} : { completionGateChecks: opts.checks }),
    limits: { maxDepth: 2, maxTotalSteps: 16 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, gateCalls: () => gateCalls, prompts: () => prompts }
}

const run = (h: ReturnType<typeof harness>, resume?: JhEngine.State) =>
  Effect.runPromise(JhEngine.runTask(h.deps, { goal: "the task" }, resume))

const gateEntries = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "completion_gate")

/** THE invariant, asserted on every run below: a `done` report is impossible unless the mechanical
 *  verifier said yes FIRST. Reads the log rather than the implementation, so it also covers any future
 *  path that reaches `done` without asking. */
function assertNoUnverifiedDone(r: JhEngine.Report, gated: boolean): void {
  if (r.status !== "done" || !gated) return
  const green = r.state.log.findIndex((e) => e.type === "completion_gate" && (e as { ok: boolean }).ok)
  const done = r.state.log.findIndex((e) => e.type === "task_done")
  expect(green).toBeGreaterThanOrEqual(0)
  expect(green).toBeLessThan(done)
}

describe("completion gate — the mechanical veto over a self-attested done", () => {
  test("a RED gate refuses the whole-task done even though the goal-check said achieved", async () => {
    const h = harness({ gate: [false] })
    const r = await run(h)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("completion_unverified")
    // The model's own claim IS present in the log — it just is not the last word.
    expect(
      r.state.log.some(
        (e) => e.type === "verification" && String((e as { detail?: unknown }).detail).includes("task goal achieved"),
      ),
    ).toBe(true)
    expect(r.state.log.some((e) => e.type === "task_done")).toBe(false)
    assertNoUnverifiedDone(r, true)
  })

  test("NEGATIVE CONTROL — the identical run with a GREEN gate reports done", async () => {
    const h = harness({ gate: [true] })
    const r = await run(h)
    expect(r.status).toBe("done")
    expect(h.gateCalls()).toBe(1) // asked once, on the claimed completion — not once per loop
    assertNoUnverifiedDone(r, true)
  })

  test("NEGATIVE CONTROL — with NO gate the engine is unchanged: the goal-check alone commits", async () => {
    const h = harness({ noGate: true })
    const r = await run(h)
    expect(r.status).toBe("done")
    expect(gateEntries(r)).toEqual([])
  })

  test("a refusal GROWS a fix node naming the failure, then re-checks (repair, not a dead end)", async () => {
    // red, then green: the harness must give the model a chance to fix what the verifier named.
    const h = harness({ gate: [false, true] })
    const r = await run(h)
    expect(r.status).toBe("done")
    expect(h.gateCalls()).toBe(2)
    const root = r.state.tree.nodes.get(r.state.tree.root)!
    expect(root.children.length).toBeGreaterThan(1) // the original phase + the gate's fix node
    // …and the verifier's own words REACHED the model — a gate that refuses without saying why would
    // leave the run guessing, which is how a bounded guard turns into a rut.
    expect(h.prompts().some((p) => p.includes("the test command failed with exit 1"))).toBe(true)
    assertNoUnverifiedDone(r, true)
  })
})

describe("completion gate — the MECHANICAL hard stop", () => {
  test("an always-red gate runs exactly completionGateChecks times, then reports NOT VERIFIED", async () => {
    const h = harness({ gate: [false], checks: 2 })
    const r = await run(h)
    expect(h.gateCalls()).toBe(2) // bounded: never a fix→recheck loop against the wall
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("completion_unverified")
    const spent = gateEntries(r).filter((e) => (e as { spent: boolean }).spent)
    expect(spent.length).toBe(0) // the 2nd refusal came from a real check, not from the budget
  })

  test("NEGATIVE CONTROL — the bound MOVES: a cap of 1 stops after one check", async () => {
    const h = harness({ gate: [false], checks: 1 })
    const r = await run(h)
    expect(h.gateCalls()).toBe(1)
    expect(r.reason).toBe("completion_unverified")
  })

  test("a spent budget REFUSES rather than passing — it is a cost cap, not an amnesty", async () => {
    // checks:0 → the verifier may never run at all. The honest outcome is "not verified", never "done".
    const h = harness({ gate: [true], checks: 0 })
    const r = await run(h)
    expect(h.gateCalls()).toBe(0)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("completion_unverified")
    expect(gateEntries(r).every((e) => (e as { spent: boolean }).spent && !(e as { ok: boolean }).ok)).toBe(true)
    // Discriminating assertion: the REFUSAL has to come from the spent branch itself, not from the
    // finalize chokepoint mopping up afterwards. A spent branch that returned ok would emit
    // `task_done` first and only then be downgraded — so this is what tells the two apart.
    expect(r.state.log.some((e) => e.type === "task_done")).toBe(false)
    assertNoUnverifiedDone(r, true)
  })

  test("a repeatedly-re-asked spent gate logs its refusal ONCE (the log is not unbounded)", async () => {
    // A graded oracle re-arms the done short-circuit on every sample, so the spent gate is re-asked
    // every loop iteration. Each refusal still holds; only the entry is deduplicated — an entry per
    // iteration would also be an unbounded number of `jh_log` rows at the next checkpoint.
    const h = harness({ gate: [false], checks: 0, taskComplete: () => ({ done: true, detail: "d", score: 1 }) })
    const r = await run(h)
    expect(r.status).toBe("blocked")
    expect(gateEntries(r).length).toBe(1)
    assertNoUnverifiedDone(r, true)
  })
})

describe("completion gate — every done path asks", () => {
  test("the ORACLE-DONE short-circuit cannot skip it", async () => {
    // `taskComplete` says the task is complete on the first sample; without the gate that ends the run
    // immediately (`oracle_done`). The mechanical verifier still gets the last word.
    const h = harness({ gate: [false], taskComplete: () => ({ done: true, detail: "d", score: 1 }) })
    const r = await run(h)
    expect(r.state.log.some((e) => e.type === "oracle_done")).toBe(false)
    expect(r.status).not.toBe("done")
    assertNoUnverifiedDone(r, true)
  })

  test("NEGATIVE CONTROL — the same oracle with a GREEN gate does short-circuit to done", async () => {
    const h = harness({ gate: [true], taskComplete: () => ({ done: true, detail: "d", score: 1 }) })
    const r = await run(h)
    expect(r.state.log.some((e) => e.type === "oracle_done")).toBe(true)
    expect(r.status).toBe("done")
    assertNoUnverifiedDone(r, true)
  })

  test("a RESUMED tree whose root is already committed is re-verified, not trusted", async () => {
    // The gate is per-PROCESS state; a checkpoint carries a tree, not a verification. A resume that
    // walked straight to `done` would let a crash launder an unverified completion.
    const seed = await run(harness({ gate: [true] }))
    expect(seed.status).toBe("done")
    const resumedRed = await run(harness({ gate: [false] }), seed.state)
    expect(resumedRed.status).toBe("blocked")
    expect(resumedRed.reason).toBe("completion_unverified")
    // NEGATIVE CONTROL: the same resume with a green gate is done again.
    const resumedGreen = harness({ gate: [true] })
    const ok = await run(resumedGreen, seed.state)
    expect(ok.status).toBe("done")
    expect(resumedGreen.gateCalls()).toBe(1)
    assertNoUnverifiedDone(ok, true)
  })
})
