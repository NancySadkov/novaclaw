import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"
import { JhTree } from "./tree"

// ---- scripted-deps harness: introspect+correct pull from ONE reply queue (call order); executor and
// runner (verify) pull from their own queues. LLM_FAIL makes a model call fail. ----
const LLM_FAIL = "__LLM_FAIL__"

function scriptedDeps(opts: {
  replies: string[]
  observations?: JhBasicTools.Observation[]
  runResults?: JhProcessRunner.RunResult[]
  runByCommand?: (command: string) => JhProcessRunner.RunResult
  fileExists?: (rel: string, cwd: string) => boolean
  trigger?: JhBudget.SplitTrigger
  limits?: { maxDepth: number; maxTotalSteps: number }
  checkpoint?: (s: JhEngine.State) => Effect.Effect<void>
  artifacts?: JhArtifact.Store
  forceRootDecompose?: boolean
  verifyGoal?: boolean
  goalCheckCache?: boolean
  evidence?: boolean
}) {
  const replies = [...opts.replies]
  const observations = [...(opts.observations ?? [])]
  const runResults = [...(opts.runResults ?? [])]
  let modelCalls = 0
  let runnerCalls = 0
  const artifacts = opts.artifacts ?? JhArtifact.memory()

  const nextReply = () => {
    modelCalls++
    const r = replies.shift()
    if (r === undefined || r === LLM_FAIL) return Effect.fail({ message: "scripted llm fail" })
    return Effect.succeed(r)
  }
  const deps: JhEngine.Deps = {
    introspect: () => nextReply(),
    correct: () => nextReply(),
    executor: { run: () => Effect.succeed(observations.shift() ?? { ok: false, output: "no scripted observation", artifacts: new Map() }) },
    runner: {
      run: (input: { command: string; cwd: string; timeoutMs: number }) => {
        runnerCalls++
        if (opts.runByCommand) return Effect.succeed(opts.runByCommand(input.command))
        return Effect.succeed(runResults.shift() ?? { exitCode: 0, output: "", timedOut: false })
      },
    },
    artifacts,
    fileExists: opts.fileExists ?? (() => false),
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    limits: opts.limits ?? { maxDepth: 4, maxTotalSteps: 64 },
    trigger: opts.trigger ?? JhBudget.DEFAULT_TRIGGER,
    checkpoint: opts.checkpoint,
    forceRootDecompose: opts.forceRootDecompose,
    verifyGoal: opts.verifyGoal,
    // R2 levers default OFF in the test helper so legacy goal-check tests reproduce pre-R2 behavior (L2);
    // the P2 tests opt in explicitly, and the real harness (flags undefined) gets them ON.
    goalCheckCache: opts.goalCheckCache ?? false,
    evidence: opts.evidence ?? false,
  }
  return { deps, artifacts, modelCalls: () => modelCalls, runnerCalls: () => runnerCalls }
}

const reply = (o: unknown) => JSON.stringify(o)
const atomObj = (over: Record<string, unknown> = {}) => ({
  goal: "leaf",
  size: "atomic",
  tool: "note",
  args: { text: "x" },
  success: "ok",
  check: { type: "artifact_present" },
  produces: [{ id: "out", type: "note" }],
  ...over,
})
const compoundObj = (substeps: unknown[]) => ({ goal: "root", size: "needs_decomposition", success: "ok", substeps })
const okObs = (artifacts: Record<string, string> = {}): JhBasicTools.Observation => ({ ok: true, output: "o", artifacts: new Map(Object.entries(artifacts)) })
const failObs = (output = "boom"): JhBasicTools.Observation => ({ ok: false, output, artifacts: new Map() })
const run = (d: ReturnType<typeof scriptedDeps>) => Effect.runPromise(JhEngine.runTask(d.deps, { goal: "the task" }))
const types = (r: JhEngine.Report) => r.state.log.map((e) => e.type)

describe("JhEngine.runTask", () => {
  test("1. single atom happy path", async () => {
    const d = scriptedDeps({ replies: [reply(atomObj())], observations: [okObs({ out: "x" })] })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r)).toEqual(["task_started", "introspected", "action", "observation", "verification", "committed", "task_done"])
    expect(d.artifacts.get("out")?.content).toBe("x")
  })

  test("2. one decomposition, both leaves commit, preorder", async () => {
    const d = scriptedDeps({
      replies: [
        reply(compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })])),
        reply(atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] })),
        reply(atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })),
      ],
      observations: [okObs({ a1: "x" }), okObs({ b1: "x" })],
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    const t = types(r)
    // child 1's action logged before child 2's introspection
    const firstAction = t.indexOf("action")
    const secondIntrospect = t.indexOf("introspected", t.indexOf("introspected", t.indexOf("introspected") + 1) + 1)
    expect(firstAction).toBeLessThan(secondIntrospect)
    expect(t.filter((x) => x === "committed").length).toBe(3) // 2 leaves + root
  })

  test("3. verify fail → directive recovery (edit) → pass", async () => {
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ tool: "write_file", args: { path: "f.c", content: "bad" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })),
        reply(atomObj({ tool: "write_file", args: { path: "f.c", content: "good" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })), // recovery: fix the source
      ],
      observations: [okObs({ f: "bad" }), okObs({ f: "good" })],
      runResults: [{ exitCode: 1, output: "err", timedOut: false }, { exitCode: 0, output: "", timedOut: false }],
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r).filter((t) => t === "introspected").length).toBe(2) // root introspect + one recovery
    expect(r.state.telemetry.get("root")?.attempts).toBe(2)
    expect(d.runnerCalls()).toBe(2)
  })

  test("4. budget exhaustion → forced decomposition (no forced_split log)", async () => {
    // stuck needs the SAME error STUCK_REPEATS (3) times → 3 compile failures before the forced decompose.
    const writeAtom = reply(atomObj({ tool: "write_file", difficulty_prior: "trivial", args: { path: "f.c", content: "x" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] }))
    const d = scriptedDeps({
      replies: [
        writeAtom,
        writeAtom, // recovery attempt 2
        writeAtom, // recovery attempt 3 (3rd identical compile fail → stuck)
        reply(compoundObj([atomObj({ goal: "g1", produces: [{ id: "g1", type: "note" }] }), atomObj({ goal: "g2", produces: [{ id: "g2", type: "note" }] })])),
        reply(atomObj({ goal: "g1", produces: [{ id: "g1", type: "note" }] })),
        reply(atomObj({ goal: "g2", produces: [{ id: "g2", type: "note" }] })),
      ],
      observations: [okObs({ f: "x" }), okObs({ f: "y" }), okObs({ f: "z" }), okObs({ g1: "x" }), okObs({ g2: "x" })],
      runResults: [
        { exitCode: 1, output: "e", timedOut: false },
        { exitCode: 1, output: "e", timedOut: false },
        { exitCode: 1, output: "e", timedOut: false },
      ],
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r)).toContain("expanded")
    expect(types(r)).not.toContain("forced_split")
  })

  test("5. budget exhaustion at maxDepth → blocked, no throw", async () => {
    const d = scriptedDeps({
      replies: [reply(atomObj({ tool: "write_file", difficulty_prior: "trivial", args: { path: "f.c", content: "x" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })), "```\nfix\n```"],
      observations: [okObs({ f: "x" }), okObs({ f: "y" })],
      runResults: [{ exitCode: 1, output: "e", timedOut: false }, { exitCode: 1, output: "e", timedOut: false }],
      limits: { maxDepth: 0, maxTotalSteps: 64 },
    })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("budget")
    expect(r.state.log.some((e) => e.type === "blocked" && e.reason === "budget")).toBe(true)
  })

  test("6. dataflow repair: fixed → expanded; still broken → blocked(dataflow)", async () => {
    const dangling = compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", consumes: [{ id: "missing", type: "file" }] })])
    const fixed = compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })])
    const good = scriptedDeps({
      replies: [reply(dangling), reply(fixed), reply(atomObj({ produces: [{ id: "a1", type: "note" }] })), reply(atomObj({ produces: [{ id: "b1", type: "note" }] }))],
      observations: [okObs({ a1: "x" }), okObs({ b1: "x" })],
    })
    const rg = await run(good)
    expect(rg.status).toBe("done")
    const gt = types(rg)
    expect(gt.indexOf("dataflow_rejected")).toBeLessThan(gt.indexOf("expanded"))

    const bad = scriptedDeps({ replies: [reply(dangling), reply(dangling)] })
    const rb = await run(bad)
    expect(rb.status).toBe("blocked")
    expect(rb.reason).toBe("dataflow")
  })

  test("7. force-split: cardinality over trigger → forced_split → decompose; atomic-again → cannot_split", async () => {
    const nineConsumes = Array.from({ length: 9 }, (_, i) => ({ id: `c${i}`, type: "file" as const }))
    const split = scriptedDeps({
      replies: [
        reply(atomObj({ consumes: nineConsumes, produces: [] })),
        reply(compoundObj([atomObj({ goal: "s1", produces: [{ id: "s1", type: "note" }] }), atomObj({ goal: "s2", produces: [{ id: "s2", type: "note" }] })])),
        reply(atomObj({ produces: [{ id: "s1", type: "note" }] })),
        reply(atomObj({ produces: [{ id: "s2", type: "note" }] })),
      ],
      observations: [okObs({ s1: "x" }), okObs({ s2: "x" })],
    })
    const rs = await run(split)
    expect(rs.status).toBe("done")
    expect(types(rs)).toContain("forced_split")

    const stuck = scriptedDeps({ replies: [reply(atomObj({ consumes: nineConsumes, produces: [] })), reply(atomObj({ produces: [] }))], observations: [okObs()] })
    const ru = await run(stuck)
    expect(ru.status).toBe("blocked")
    expect(ru.reason).toBe("cannot_split")
  })

  test("8. depth cap: needs_decomposition at maxDepth → blocked(depth_budget)", async () => {
    const d = scriptedDeps({
      replies: [reply(compoundObj([atomObj({ goal: "child", produces: [{ id: "c1", type: "note" }] })])), reply(compoundObj([atomObj({ goal: "deeper", produces: [{ id: "d1", type: "note" }] })]))],
      limits: { maxDepth: 1, maxTotalSteps: 64 },
    })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(r.state.log.some((e) => e.type === "blocked" && e.reason === "depth_budget")).toBe(true)
  })

  test("9. step cap: decomposition overflowing maxTotalSteps → blocked(step_budget)", async () => {
    const four = compoundObj(["a", "b", "c", "d"].map((g) => atomObj({ goal: g, produces: [{ id: g, type: "note" }] })))
    const d = scriptedDeps({ replies: [reply(four)], limits: { maxDepth: 4, maxTotalSteps: 3 } })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("step_budget")
  })

  test("10. tool failure is data — verify NOT invoked, obs.output is the detail", async () => {
    const d = scriptedDeps({
      replies: [reply(atomObj({ tool: "write_file", difficulty_prior: "trivial", args: { path: "f.c", content: "x" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })), "```\nfix\n```"],
      observations: [failObs("tool boom"), failObs("tool boom")],
      limits: { maxDepth: 0, maxTotalSteps: 64 },
    })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(d.runnerCalls()).toBe(0) // verify skipped because obs.ok was false
    expect(r.state.log.some((e) => e.type === "verification" && !e.ok && e.detail === "tool boom")).toBe(true)
  })

  test("11. parse failure: recover on retry; persistently → blocked(unparseable)", async () => {
    const recover = scriptedDeps({ replies: ["not json at all", reply(atomObj())], observations: [okObs({ out: "x" })] })
    const rr = await run(recover)
    expect(rr.status).toBe("done")
    const rt = types(rr)
    expect(rt.indexOf("parse_failed")).toBeLessThan(rt.indexOf("introspected"))

    // improve3 P2a: the ROOT now gets ROOT_INTROSPECT_ATTEMPTS (10) parse-retries before giving up (run63/§I3
    // died at 2). Persistent garbage across all attempts → blocked(unparseable).
    const stuck = scriptedDeps({ replies: Array.from({ length: 10 }, () => "garbage") })
    const rs = await run(stuck)
    expect(rs.status).toBe("blocked")
    expect(rs.reason).toBe("unparseable")
  })

  test("12. structural failure: recover on retry", async () => {
    const d = scriptedDeps({ replies: [reply(atomObj({ substeps: [atomObj()] })), reply(atomObj())], observations: [okObs({ out: "x" })] })
    const r = await run(d)
    expect(r.status).toBe("done")
    const t = types(r)
    expect(t.indexOf("structural_rejected")).toBeLessThan(t.indexOf("introspected"))
  })

  test("13. LLM failure twice → blocked(llm_unreachable)", async () => {
    const d = scriptedDeps({ replies: [LLM_FAIL, LLM_FAIL] })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(r.state.log.some((e) => e.type === "blocked" && e.reason === "llm_unreachable")).toBe(true)
  })

  test("14. determinism: same scenario twice → identical log", async () => {
    const scenario = () =>
      scriptedDeps({
        replies: [
          reply(compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })])),
          reply(atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] })),
          reply(atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })),
        ],
        observations: [okObs({ a1: "x" }), okObs({ b1: "x" })],
      })
    const a = await run(scenario())
    const b = await run(scenario())
    expect(JSON.stringify(a.state.log)).toBe(JSON.stringify(b.state.log))
  })

  test("15. resume from a checkpoint completes with the same combined log", async () => {
    const scenarioReplies = () => [
      reply(compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })])),
      reply(atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] })),
      reply(atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })),
    ]
    const fullRun = await run(scriptedDeps({ replies: scenarioReplies(), observations: [okObs({ a1: "x" }), okObs({ b1: "x" })] }))
    const fullTypes = types(fullRun)

    let captured: JhEngine.State | undefined
    await run(
      scriptedDeps({
        replies: scenarioReplies(),
        observations: [okObs({ a1: "x" }), okObs({ b1: "x" })],
        checkpoint: (s) => Effect.sync(() => { if (!captured) captured = s }),
      }),
    )
    expect(captured).toBeDefined()

    const resumed = await Effect.runPromise(
      JhEngine.runTask(
        scriptedDeps({
          replies: [reply(atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] }))],
          observations: [okObs({ b1: "x" })],
          artifacts: JhArtifact.memory(captured!.artifacts),
        }).deps,
        { goal: "the task" },
        captured,
      ),
    )
    expect(resumed.status).toBe("done")
    expect(resumed.state.log.map((e) => e.type)).toEqual(fullTypes)
  })

  test("16. adversarial replies never throw — always a Report", async () => {
    const hostiles = [
      "",
      "null",
      "{}",
      '{"size":"atomic"}',
      '{"goal":"g","size":"huge","success":"s"}',
      '{"goal":"g","size":"atomic","tool":"note","args":"notanobject","success":"s"}',
      '{"goal":"g","size":"atomic","tool":"note","args":{},"success":"s","check":{"type":"bogus"}}',
      reply(compoundObj([compoundObj([compoundObj([compoundObj([compoundObj([atomObj()])])])])])),
      reply(atomObj({ goal: "x".repeat(5000) })),
      "```json\n{not: valid}\n```",
    ]
    for (const h of hostiles) {
      const d = scriptedDeps({ replies: [h, h] })
      const r = await run(d)
      expect(["done", "blocked"]).toContain(r.status)
    }
  })

  test("17. research_needed → research_flagged, execution proceeds", async () => {
    const d = scriptedDeps({ replies: [reply(atomObj({ research_needed: true }))], observations: [okObs({ out: "x" })] })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r)).toContain("research_flagged")
  })

  test("18. exploration budget: NOVEL errors extend past the prior budget until convergence", async () => {
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ tool: "write_file", difficulty_prior: "trivial", args: { path: "f.c", content: "v0" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })),
        "```\nv1\n```",
        "```\nv2\n```",
      ],
      observations: [okObs({ f: "v0" }), okObs({ f: "v1" }), okObs({ f: "v2" })],
      runResults: [
        { exitCode: 1, output: "error A: missing header", timedOut: false },
        { exitCode: 1, output: "error B: undefined symbol", timedOut: false },
        { exitCode: 0, output: "", timedOut: false },
      ],
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(r.state.telemetry.get("root")?.attempts).toBe(3) // trivial=1 would exhaust at 2 WITHOUT the extension
  })

  test("18b. stuck: a REPEATED error ends the leaf at the budget (no runaway)", async () => {
    const d = scriptedDeps({
      replies: [reply(atomObj({ tool: "write_file", difficulty_prior: "trivial", args: { path: "f.c", content: "x" }, check: { type: "compile", command: "gcc" }, produces: [{ id: "f", type: "file" }] })), "```\nfix\n```"],
      observations: [okObs({ f: "x" }), okObs({ f: "y" })],
      runResults: [{ exitCode: 1, output: "same error", timedOut: false }, { exitCode: 1, output: "same error", timedOut: false }],
      limits: { maxDepth: 0, maxTotalSteps: 64 },
    })
    const r = await run(d)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("budget")
  })

  test("19. duplicate_produce is TOLERATED — only dangling consumes blocks a decomposition", async () => {
    const dup = compoundObj([atomObj({ goal: "a", produces: [{ id: "shared", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "shared", type: "note" }] })])
    const d = scriptedDeps({
      replies: [reply(dup), reply(atomObj({ produces: [{ id: "shared", type: "note" }] })), reply(atomObj({ produces: [{ id: "shared", type: "note" }] }))],
      observations: [okObs({ shared: "x" }), okObs({ shared: "y" })],
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r)).toContain("expanded")
    expect(types(r)).not.toContain("dataflow_rejected")
  })

  test("20. root soft-decompose: an atomic root is nudged to decompose (no false-done)", async () => {
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ goal: "the whole task", produces: [{ id: "out", type: "note" }] })), // root claims atomic
        reply(compoundObj([atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] }), atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })])),
        reply(atomObj({ goal: "a", produces: [{ id: "a1", type: "note" }] })),
        reply(atomObj({ goal: "b", produces: [{ id: "b1", type: "note" }] })),
      ],
      observations: [okObs({ a1: "x" }), okObs({ b1: "x" })],
      forceRootDecompose: true,
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    const t = types(r)
    expect(t).toContain("expanded")
    expect(t.indexOf("expanded")).toBeLessThan(t.indexOf("action")) // root never ran as a single atomic leaf
  })

  test("21. root soft-decompose FALLS BACK to atomic when the model insists (simple task)", async () => {
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ goal: "simple", produces: [{ id: "out", type: "note" }] })),
        reply(atomObj({ goal: "simple", produces: [{ id: "out", type: "note" }] })), // insists atomic
      ],
      observations: [okObs({ out: "x" })],
      forceRootDecompose: true,
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    expect(types(r)).not.toContain("expanded")
    expect(types(r)).toContain("committed")
  })

  test("22. verifyGoal OFF: a passing weak check commits with NO goal-check call", async () => {
    const d = scriptedDeps({ replies: [reply(atomObj())], observations: [okObs({ out: "x" })] })
    const r = await run(d)
    expect(types(r)).toContain("committed")
    expect(d.modelCalls()).toBe(1) // introspect only — no goal-check LLM call
  })

  test("23. verifyGoal ON + goal ACHIEVED: weak check commits (extra goal-check call)", async () => {
    const d = scriptedDeps({ replies: [reply(atomObj()), `{"achieved": true}`], observations: [okObs({ out: "x" })], verifyGoal: true })
    const r = await run(d)
    expect(types(r)).toContain("committed")
    expect(d.modelCalls()).toBe(2) // introspect + goal-check
  })

  test("24. verifyGoal ON + goal NOT achieved: weak-check pass is DEMOTED to a verify fail (no false-done)", async () => {
    const no = `{"achieved": false, "missing": "not compiled/verified"}`
    const d = scriptedDeps({
      replies: [reply(atomObj({ difficulty_prior: "trivial" })), no, reply(atomObj({ difficulty_prior: "trivial" })), no],
      observations: [okObs({ out: "x" }), okObs({ out: "x" })],
      verifyGoal: true,
    })
    const r = await run(d)
    const verifs = r.state.log.filter((e) => e.type === "verification")
    // the mechanical artifact_present check passed, yet the goal-check demoted it → a verify FAIL surfaced
    expect(verifs.some((e) => "ok" in e && e.ok === false && String((e as { detail?: unknown }).detail).includes("goal not yet achieved"))).toBe(true)
    // and the root was NOT committed on that false-done
    expect(types(r)).not.toContain("committed")
  })

  test("26. recovery must NOT DOWNGRADE the check — a run+expect gate survives a write_file detour", async () => {
    // iter 20 false-done: the leaf's strong run-check (correct-Pi expect) got replaced by the write_file
    // recovery's weak artifact_present check, so a stale binary false-passed. The gate must be preserved.
    const runCheck = { type: "run", command: ".\\pi.exe", expect: "3.14159" }
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ tool: "run", args: { command: ".\\pi.exe" }, check: runCheck, produces: [], difficulty_prior: "trivial" })),
        // recovery: switch to write_file with a WEAK check — must be rejected in favor of the run gate
        reply(atomObj({ tool: "write_file", args: { path: "pi.c", content: "x" }, check: { type: "artifact_present" }, produces: [{ id: "pi.c", type: "file" }], difficulty_prior: "trivial" })),
        reply(atomObj({ tool: "write_file", args: { path: "pi.c", content: "y" }, check: { type: "artifact_present" }, produces: [{ id: "pi.c", type: "file" }], difficulty_prior: "trivial" })),
        reply(atomObj({ tool: "write_file", args: { path: "pi.c", content: "z" }, check: { type: "artifact_present" }, produces: [{ id: "pi.c", type: "file" }], difficulty_prior: "trivial" })),
      ],
      observations: [okObs(), okObs({ "pi.c": "x" }), okObs({ "pi.c": "y" }), okObs({ "pi.c": "z" })],
      // the program always prints wrong output → the run gate NEVER passes; a downgrade to artifact_present WOULD have
      runByCommand: () => ({ exitCode: 0, output: "3000", timedOut: false }),
      limits: { maxDepth: 0, maxTotalSteps: 8 }, // depth 0 → a stuck leaf blocks (no decompose), clean terminal
    })
    const r = await run(d)
    expect(r.status).not.toBe("done") // the weak check never false-committed the leaf
    expect(types(r)).not.toContain("committed")
  })

  test("25. recovery that corrects the command ALSO moves the check (no stale-check re-fail)", async () => {
    // iter 19: action fixed `pi.exe`→`.\\pi.exe` (ran ok) but the frozen check kept running `pi.exe` → fail.
    const d = scriptedDeps({
      replies: [
        reply(atomObj({ tool: "run", args: { command: "pi.exe" }, check: { type: "run", command: "pi.exe" }, produces: [] })),
        reply(atomObj({ tool: "run", args: { command: ".\\pi.exe" }, check: { type: "run", command: ".\\pi.exe" }, produces: [] })), // recovery corrects BOTH command and check
      ],
      observations: [okObs(), okObs()],
      // command-sensitive: bare `pi.exe` is "not recognized" (exit 1); `.\pi.exe` runs (exit 0)
      runByCommand: (cmd) => (cmd.includes(".\\pi.exe") ? { exitCode: 0, output: "Pi", timedOut: false } : { exitCode: 1, output: "'pi.exe' is not recognized", timedOut: false }),
    })
    const r = await run(d)
    expect(r.status).toBe("done") // the corrected check runs `.\pi.exe` and passes — no infinite stale-check fail
    expect(types(r)).toContain("committed")
    expect(types(r).filter((t) => t === "introspected").length).toBe(2)
  })

  test("27. root-completion goal-check EXTENDS with a fix node when the whole-task goal isn't met", async () => {
    // iter 21 false-done: children all committed (weak per-step checks passed) but the program printed wrong
    // output. The root-level goal-check must catch it and GROW a fix node (owner #2+#5), not report done.
    const runAtom = (goal: string, cmd: string) => reply(atomObj({ goal, tool: "run", args: { command: cmd }, check: { type: "run", command: cmd }, produces: [] }))
    const d = scriptedDeps({
      replies: [
        reply(compoundObj([atomObj({ goal: "g1", tool: "run", args: { command: "a" }, check: { type: "run", command: "a" }, produces: [] })])), // root decomposes → 1 child
        runAtom("g1", "a"), // root.1 introspect → runs, commits
        `{"achieved": false, "missing": "the program prints wrong digits"}`, // root goal-check #1 → NOT achieved
        runAtom("fix", "b"), // the appended root.2 (fix) introspect → runs, commits
        `{"achieved": true, "missing": ""}`, // root goal-check #2 → achieved
      ],
      observations: [okObs(), okObs()],
      runResults: [{ exitCode: 0, output: "", timedOut: false }, { exitCode: 0, output: "", timedOut: false }],
      verifyGoal: true,
    })
    const r = await run(d)
    expect(r.status).toBe("done")
    // the root GREW a second child (the fix node) — it was not a false-done
    expect(JhTree.get(r.state.tree, r.state.tree.root)?.children.length).toBe(2)
    // two root-level goal verifications: first fail, then pass
    const rootVerifs = r.state.log.filter((e) => e.type === "verification" && "step" in e && (e as { step?: string }).step === r.state.tree.root)
    expect(rootVerifs.map((e) => (e as { ok?: boolean }).ok)).toEqual([false, true])
  })

  test("28. a stuck NON-root leaf GROWS a fix sibling instead of dead-ending its ancestors (verifyGoal)", async () => {
    // iter 26: a run leaf re-ran the same wrong binary 3× and blocked → cascaded up. Under verifyGoal it must
    // best-effort-commit and extend its parent with a fix node; the root goal-check is the backstop.
    const runAtom = (cmd: string) => reply(atomObj({ goal: `run ${cmd}`, tool: "run", args: { command: cmd }, check: { type: "run", command: cmd, expect: "PI" }, produces: [], difficulty_prior: "trivial" }))
    const d = scriptedDeps({
      replies: [
        reply(compoundObj([atomObj({ goal: "run a", tool: "run", args: { command: "a" }, check: { type: "run", command: "a", expect: "PI" }, produces: [], difficulty_prior: "trivial" })])),
        runAtom("a"), // root.1 introspect
        runAtom("a"), // recovery (re-run) after fail 1
        runAtom("a"), // recovery (re-run) after fail 2 → fail 3 = stuck → extend
        runAtom("b"), // the appended fix node root.2 introspect → runs `b` which is correct
        `{"achieved": true}`, // root goal-check → done
      ],
      observations: [okObs(), okObs(), okObs(), okObs()],
      runByCommand: (cmd) => (cmd === "b" ? { exitCode: 0, output: "PI=3.14", timedOut: false } : { exitCode: 0, output: "wrong", timedOut: false }),
      verifyGoal: true,
    })
    const r = await run(d)
    expect(r.status).toBe("done") // NOT blocked — the leaf extended instead of dead-ending
    expect(JhTree.get(r.state.tree, r.state.tree.root)?.children.length).toBe(2) // root.1 + grown fix sibling root.2
    expect(types(r)).not.toContain("blocked")
  })

  // 0a (jh-improve1 R0): the ORACLE INVARIANT — with a precise `taskComplete` oracle that returns
  // done:false EVERY time and an expander that "solves" every mechanical check, runTask must NEVER report
  // status:"done". It may only keep EXTENDING the root with fix nodes until the step budget, then block
  // honestly. This guards run-32's D9 contradiction (`task_done` reached while the oracle was negative).
  test("0a. oracle invariant: taskComplete never-done ⇒ runTask never reports done", async () => {
    // Leaves use a `run` check (not a weak artifact_present) so verifyGoal's weak-check goal demotion never
    // fires — the ONLY oracle consulted is taskComplete, at the root-completion gate. Faithful to the real
    // harness (verifyGoal + taskComplete both on).
    const solve = reply(atomObj({ tool: "run", args: { command: "x" }, check: { type: "run", command: "x" }, produces: [] }))
    const rootDecomp = reply(compoundObj([atomObj({ goal: "child", tool: "run", args: { command: "x" }, check: { type: "run", command: "x" }, produces: [] })]))
    let calls = 0
    const maxTotalSteps = 12
    const deps: JhEngine.Deps = {
      introspect: () => { calls++; return Effect.succeed(calls === 1 ? rootDecomp : solve) }, // 1st = root decompose, rest = atomic solves
      correct: () => Effect.succeed(solve),
      executor: { run: () => Effect.succeed({ ok: true, output: "o", artifacts: new Map<string, string>() }) },
      runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
      artifacts: JhArtifact.memory(),
      fileExists: () => false,
      cwd: ".",
      toolNames: JhBasicTools.TOOL_NAMES,
      verifyGoal: true,
      taskComplete: () => ({ done: false, detail: "no" }), // the oracle is ALWAYS negative
      limits: { maxDepth: 4, maxTotalSteps },
      trigger: JhBudget.DEFAULT_TRIGGER,
    }
    const r = await Effect.runPromise(JhEngine.runTask(deps, { goal: "the task" }))
    expect(r.status).not.toBe("done") // the invariant: a never-done oracle can NEVER yield status:done
    expect(r.status).toBe("blocked")
    expect(r.reason === "goal_unmet" || r.reason === "step_budget").toBe(true) // extended to the budget, then blocked honestly
    expect(r.state.tree.nodes.size).toBeGreaterThanOrEqual(maxTotalSteps - 1) // it actually grew fix nodes
    // and it NEVER emitted task_done
    expect(types(r)).not.toContain("task_done")
  })
})
