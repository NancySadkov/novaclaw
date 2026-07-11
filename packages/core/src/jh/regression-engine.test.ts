import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// jh-improve4 P1 — the persistent regression suite, ENGINE integration. The centrepiece is the run75
// fixture: after a primitive test (`t_mul`) is locked green, an edit to the library it depends on
// (`bigint.c`) — made while the model believes it is working on the `pi.c` formula — is caught IMMEDIATELY
// by re-running the registered test, and the verification NAMES `bigint.c`, not the formula. That is the
// whole point of the wave, encoded as a permanent regression test.
//
// A tiny in-memory build world models a compiler + loader: `write_file`/`edit_file` mutate sources; a `gcc
// … -o OUT` run writes an OUT "binary" file (so staleness tracks it as a product); a `./OUT` run invokes a
// per-exe `program(files)` the test declares, whose output depends on the CURRENT source contents — so an
// edit to a library flips a previously-passing test to failing. Commands may chain with `&&`.

interface Program {
  (files: ReadonlyMap<string, string>): { readonly code: number; readonly output: string }
}

function buildWorld(opts: { initial: Record<string, string>; programs: Record<string, Program> }) {
  const files = new Map(Object.entries(opts.initial))
  let checkpoint = new Map(files) // last verified snapshot (for revertWorkspace / git_revert)

  const base = (p: string): string => (p.replace(/^\.[/\\]/, "").split(/[/\\]/).pop() ?? p)

  const execProgram = (command: string): { code: number; output: string } => {
    const parts = command.split("&&").map((s) => s.trim())
    let output = ""
    for (const seg of parts) {
      if (/(^|\s)gcc\b/.test(seg)) {
        const outMatch = seg.match(/-o\s+(\S+)/)
        const srcs = (seg.match(/\S+\.c\b/g) ?? []).map(base)
        // improve6: name the offending file the way a real compiler does — the damage/suspect classifiers
        // read diagnostics SHAPE (`file.c:1:1: error:`), and a bare "compile error" is not a real gcc output.
        const bad = srcs.find((s) => (files.get(s) ?? "").includes("BUILDERR"))
        if (bad) return { code: 1, output: `${output}${bad}:1:1: error: BUILDERR` }
        if (outMatch) files.set(base(outMatch[1]!), `bin(${srcs.map((s) => `${s}:${files.get(s) ?? ""}`).join(";")})`)
        continue
      }
      // a run of a compiled binary — resolve its basename and invoke the declared program.
      const exe = base(seg.split(/\s+/)[0] ?? "")
      const prog = opts.programs[exe]
      if (!files.has(exe) || !prog) return { code: 1, output: `${output}'${exe}' is not recognized (not built)` }
      const r = prog(files)
      output += r.output
      if (r.code !== 0) return { code: r.code, output }
    }
    return { code: 0, output }
  }

  const runner: JhProcessRunner.Runner = {
    run: ({ command }) => {
      const r = execProgram(command)
      return Effect.succeed({ exitCode: r.code, output: r.output, timedOut: false })
    },
  }
  const executor: JhBasicTools.Executor = {
    run: ({ tool, args }) => {
      if (tool === "write_file") {
        files.set(base(String(args.path)), String(args.content))
        return Effect.succeed({ ok: true, output: "wrote", artifacts: new Map<string, string>() })
      }
      if (tool === "edit_file") {
        const p = base(String(args.path))
        const cur = files.get(p) ?? ""
        const next = cur.split(String(args.old_string)).join(String(args.new_string))
        const ok = next !== cur
        if (ok) files.set(p, next)
        return Effect.succeed({ ok, output: ok ? "edited" : `old_string not found in ${p}`, artifacts: new Map<string, string>() })
      }
      if (tool === "git_revert") {
        for (const k of [...files.keys()]) if (!checkpoint.has(k)) files.delete(k)
        for (const [k, v] of checkpoint) files.set(k, v)
        return Effect.succeed({ ok: true, output: "reverted", artifacts: new Map<string, string>() })
      }
      const r = execProgram(String(args.command))
      return Effect.succeed({ ok: r.code === 0, output: r.output, artifacts: new Map<string, string>() })
    },
  }
  const listFiles = () => [...files].map(([name, content]) => ({ name, content }))
  const revertWorkspace = () =>
    Effect.sync(() => {
      for (const k of [...files.keys()]) if (!checkpoint.has(k)) files.delete(k)
      for (const [k, v] of checkpoint) files.set(k, v)
      return { ok: true as const, detail: "restored" }
    })
  const doCheckpoint = () => Effect.sync(() => { checkpoint = new Map(files) })
  return { files, runner, executor, listFiles, revertWorkspace, doCheckpoint }
}

// a compound whose substeps are VALID atomic stubs (they must pass structuralIssues at attach time, then
// each child re-introspects to the real scripted reply); goals only, for readability.
const compound = (goals: string[]) => JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: goals.map((goal) => ({ goal, size: "atomic", tool: "note", args: { text: "x" }, check: { type: "artifact_present" }, produces: [] })) })
const atom = (over: Record<string, unknown>) => JSON.stringify({ goal: "step", size: "atomic", success: "ok", produces: [], ...over })

function harness(opts: {
  world: ReturnType<typeof buildWorld>
  replies: string[]
  regressionGate?: boolean
  phaseGate?: boolean
  rederive?: boolean
  txEdits?: boolean
  autoRevert?: boolean
  now?: () => number
  maxSuiteMs?: number
  taskComplete?: JhEngine.Deps["taskComplete"]
  defaultReply?: string // returned when the scripted replies run out (drives repeated-failure churn)
  onPrompt?: (user: string) => void // observe each introspection's prompt (e.g. to capture a grown node's goal)
  limits?: { maxDepth: number; maxTotalSteps: number }
}) {
  const replies = [...opts.replies]
  let i = 0
  const idle = opts.defaultReply ?? atom({ tool: "note", args: { text: "idle" }, check: { type: "artifact_present" } })
  const deps: JhEngine.Deps = {
    // goal-check prompts never accept (we drive completion via taskComplete); otherwise serve scripted replies.
    introspect: (p) => {
      opts.onPrompt?.(p.user)
      return p.user.includes("Is the goal fully achieved?") ? Effect.succeed(`{"achieved": false}`) : Effect.succeed(replies[i++] ?? idle)
    },
    correct: () => Effect.fail({ message: "x" }),
    executor: opts.world.executor,
    runner: opts.world.runner,
    artifacts: JhArtifact.memory(),
    fileExists: (rel) => opts.world.files.has(rel.replace(/^\.[/\\]/, "")),
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: opts.world.listFiles,
    verifyGoal: true,
    taskComplete: opts.taskComplete ?? (() => ({ done: false, detail: "not done" })),
    regressionGate: opts.regressionGate,
    phaseGate: opts.phaseGate,
    rederive: opts.rederive,
    txEdits: opts.txEdits,
    autoRevert: opts.autoRevert,
    revertWorkspace: opts.world.revertWorkspace,
    checkpoint: opts.world.doCheckpoint,
    now: opts.now,
    maxSuiteMs: opts.maxSuiteMs,
    limits: opts.limits ?? { maxDepth: 3, maxTotalSteps: 32 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return deps
}

const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "compute Pi to 100 digits" }))
const log = (r: JhEngine.Report, t: string) => r.state.log.filter((e) => e.type === t)
const has = (r: JhEngine.Report, t: string) => r.state.log.some((e) => e.type === t)
const verifDetails = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail ?? ""))

// The two-step run75 shape: step A builds + locks `t_mul` green; step B edits the file it names.
const mulProgram: Program = (f) => (f.get("bigint.c")!.includes("MUL_OK") ? { code: 0, output: "998001" } : { code: 1, output: "got 999999 expected 998001" })
const addProgram: Program = () => ({ code: 0, output: "OK-ADD" }) // independent of bigint.c — stays green when bigint.c breaks
const REGISTER_MUL = atom({ tool: "write_file", args: { path: "t_mul.c", content: "test mul" }, check: { type: "run", command: "gcc t_mul.c bigint.c -o t_mul.exe && ./t_mul.exe", expect: "998001" } })
const REGISTER_ADD = atom({ tool: "write_file", args: { path: "t_add.c", content: "test add" }, check: { type: "run", command: "gcc t_add.c bigint.c -o t_add.exe && ./t_add.exe", expect: "OK-ADD" } })
const BREAK_MUL = atom({ tool: "edit_file", args: { path: "bigint.c", old_string: "MUL_OK", new_string: "MUL_BROKEN" }, check: { type: "compile", command: "gcc pi.c bigint.c -o pi.exe" } })
const committedSteps = (r: JhEngine.Report) => log(r, "committed").map((e) => (e as { step: string }).step)

describe("jh-improve4 P1 — regression suite engine integration", () => {
  test("the run75 fixture: an edit to bigint.c (while 'working on pi.c') is caught by re-running t_mul and NAMES bigint.c", async () => {
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "formula v1" }, programs: { "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    const deps = harness({
      world,
      replies: [
        compound(["build+test the mul primitive", "work on the pi formula"]),
        REGISTER_MUL, // step A → registers ./t_mul.exe green
        atom({ tool: "edit_file", args: { path: "bigint.c", old_string: "MUL_OK", new_string: "MUL_BROKEN" }, check: { type: "compile", command: "gcc pi.c bigint.c -o pi.exe" } }), // step B — edits bigint.c, thinks it's on pi
      ],
    })
    const r = await run(deps)
    // t_mul was registered when its run check passed…
    expect(log(r, "test_registered").map((e) => (e as { command: string }).command)).toContain("gcc t_mul.c bigint.c -o t_mul.exe && ./t_mul.exe")
    // …and the bigint.c edit tripped the regression, which named bigint.c (NOT the formula).
    const regs = log(r, "regression") as Array<{ command: string; changed: ReadonlyArray<string> }>
    expect(regs.length).toBeGreaterThanOrEqual(1)
    expect(regs[0]!.changed).toEqual(["bigint.c"])
    expect(verifDetails(r).some((d) => d.startsWith("REGRESSION:") && d.includes("bigint.c") && d.includes("t_mul.exe"))).toBe(true)
  })

  test("registration is only for passing run/output_equals checks that execute a product — a compile check never registers", async () => {
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK" }, programs: { "t_mul.exe": mulProgram } })
    const deps = harness({
      world,
      replies: [
        compound(["compile-only step", "run+test step"]),
        atom({ tool: "write_file", args: { path: "u.c", content: "u" }, check: { type: "compile", command: "gcc u.c bigint.c -o u.exe" } }), // compile → NOT registered
        REGISTER_MUL, // run check on a product → registered
      ],
    })
    const r = await run(deps)
    const registered = log(r, "test_registered").map((e) => (e as { command: string }).command)
    expect(registered).toHaveLength(1)
    expect(registered[0]).toContain("./t_mul.exe")
  })

  test("flag-off (regressionGate:false): the same bigint.c edit does NOT preempt — no registration, no regression", async () => {
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "formula v1" }, programs: { "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    const deps = harness({
      world,
      regressionGate: false,
      replies: [
        compound(["build+test mul", "pi"]),
        REGISTER_MUL,
        atom({ tool: "edit_file", args: { path: "bigint.c", old_string: "MUL_OK", new_string: "MUL_BROKEN" }, check: { type: "compile", command: "gcc pi.c bigint.c -o pi.exe" } }),
      ],
    })
    const r = await run(deps)
    expect(has(r, "test_registered")).toBe(false)
    expect(has(r, "regression")).toBe(false)
  })

  test("buildDamage interplay: three consecutive regressions trip the harness auto-revert", async () => {
    // improve6 P2 (gradient-aware) deliberately REVISED the wave-4 policy this test used to pin: a test
    // that keeps failing after edits is "REGRESSION SUITE:" — workable state, NOT damage (run102's
    // 5/6-passing iteration must never be revert-cycled). What still accrues damage is true BUILD breakage
    // — the leaf's own compile check failing after source edits — and that path must keep engaging the
    // harness restore. (The still-failing-test shape is covered in improve6-engine.test.ts P2.)
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "formula v1" }, programs: { "t_mul.exe": mulProgram } })
    const damaging = (v: string) => atom({ tool: "write_file", args: { path: "bigint.c", content: `lib BUILDERR ${v}` }, check: { type: "compile", command: "gcc pi.c bigint.c -o pi.exe" } })
    const deps = harness({
      world,
      autoRevert: true,
      replies: [
        compound(["build+test mul", "break the build repeatedly"]),
        REGISTER_MUL,
        damaging("v1"), // compile damage 1
        damaging("v2"), // 2
        damaging("v3"), // 3 → revert fires
      ],
    })
    const r = await run(deps)
    const reverted = log(r, "reverted") as Array<{ reason: string }>
    expect(reverted.length).toBeGreaterThanOrEqual(1) // the auto-revert engaged on repeated COMPILE damage
    expect(reverted.some((e) => !e.reason.startsWith("revert unavailable"))).toBe(true)
  })

  test("suite budget: with two stale tests and a 0ms budget, the second is skipped and NAMED (never silently partial)", async () => {
    const addProgram: Program = () => ({ code: 0, output: "OK-ADD" })
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "v1" }, programs: { "t_add.exe": addProgram, "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    // now(): startMs=0, then every budget check returns a large value → budget (0) exceeded after the 1st test.
    const clock = [0, 100000, 100000, 100000, 100000]
    let c = 0
    const deps = harness({
      world,
      maxSuiteMs: 0,
      now: () => clock[Math.min(c++, clock.length - 1)]!,
      replies: [
        compound(["add", "mul", "edit pi"]),
        atom({ tool: "write_file", args: { path: "t_add.c", content: "a" }, check: { type: "run", command: "gcc t_add.c bigint.c -o t_add.exe && ./t_add.exe", expect: "OK-ADD" } }),
        REGISTER_MUL,
        atom({ tool: "edit_file", args: { path: "pi.c", old_string: "v1", new_string: "v2" }, check: { type: "compile", command: "gcc pi.c bigint.c -o pi.exe" } }), // touches pi.c → both t_add + t_mul stale
      ],
    })
    const r = await run(deps)
    const suites = log(r, "suite") as Array<{ green: number; red: number; skipped: number }>
    expect(suites.some((s) => s.skipped >= 1)).toBe(true) // the budget cut the suite short and it was surfaced
  })
})

describe("jh-improve4 P2 — phase gate on the regression suite", () => {
  // A phase P (root.1) with children [A registers t_add, B registers t_mul, C breaks bigint.c]. C's per-edit
  // sweep budget-SKIPS t_mul (so it commits), leaving t_mul stale+red — which the PHASE GATE catches when P
  // completes. `now: () => c++` with a 0ms budget makes every multi-test sweep run only its first stale test.
  const RED_PHASE_REPLIES = [compound(["phase P"]), compound(["reg add", "reg mul", "break"]), REGISTER_ADD, REGISTER_MUL, BREAK_MUL]

  test("a phase with a red suite does NOT commit — it grows a fix node instead (t_mul broke, per-edit budget missed it)", async () => {
    let c = 0
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "v1" }, programs: { "t_add.exe": addProgram, "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    const deps = harness({ world, maxSuiteMs: 0, now: () => c++, replies: RED_PHASE_REPLIES })
    const r = await run(deps)
    const suites = log(r, "suite") as Array<{ step: string; red: number }>
    expect(suites.some((s) => s.step === "root.1" && s.red >= 1)).toBe(true) // the phase gate found the broken foundation
    expect(committedSteps(r)).not.toContain("root.1") // the phase never committed on a red suite
    expect(r.status).not.toBe("done") // no false phase/task completion
  })

  test("phaseGate:false — the same phase COMMITS despite the broken foundation (wave-3 parity)", async () => {
    let c = 0
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "v1" }, programs: { "t_add.exe": addProgram, "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    const deps = harness({ world, phaseGate: false, maxSuiteMs: 0, now: () => c++, replies: RED_PHASE_REPLIES })
    const r = await run(deps)
    expect(committedSteps(r)).toContain("root.1") // with the gate off, the phase commits on the (silently) broken foundation
    expect((log(r, "suite") as Array<{ red: number }>).some((s) => s.red >= 1)).toBe(false) // no phase-gate evaluation happened
  })

  test("a green phase commits, and the gate logs the (empty/green) suite evaluation", async () => {
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK" }, programs: { "t_add.exe": addProgram } })
    const deps = harness({ world, replies: [compound(["phase P"]), compound(["reg add"]), REGISTER_ADD] })
    const r = await run(deps)
    expect(committedSteps(r)).toContain("root.1") // green suite → the phase commits
    const suites = log(r, "suite") as Array<{ step: string; red: number }>
    expect(suites.some((s) => s.step === "root.1")).toBe(true) // a gate evaluation was logged for the phase
    expect(suites.every((s) => s.red === 0)).toBe(true) // nothing red
  })

  test("root gate ordering: a red suite gates the oracle — the root's completion verification never runs", async () => {
    // root's children directly: [A registers t_mul, B breaks bigint.c with per-edit budget skip]. At root
    // completion the suite is red → grow a fix node and re-loop; the (precision-bounded) oracle never runs.
    let c = 0
    const world = buildWorld({ initial: { "bigint.c": "lib MUL_OK", "pi.c": "v1" }, programs: { "t_add.exe": addProgram, "t_mul.exe": mulProgram, "pi.exe": () => ({ code: 0, output: "3.14" }) } })
    const deps = harness({
      world,
      maxSuiteMs: 0,
      now: () => c++,
      // A registers t_add (so the per-edit sweep on B has an earlier stale test to spend the budget on), B
      // registers t_mul, C breaks bigint.c — all direct children of the root.
      replies: [compound(["reg add", "reg mul", "break"]), REGISTER_ADD, REGISTER_MUL, BREAK_MUL],
      limits: { maxDepth: 2, maxTotalSteps: 20 },
    })
    const r = await run(deps)
    expect((log(r, "suite") as Array<{ step: string; red: number }>).some((s) => s.step === "root" && s.red >= 1)).toBe(true) // the root suite ran and was red
    const rootVerifs = log(r, "verification").filter((e) => (e as { step: string }).step === "root")
    expect(rootVerifs).toHaveLength(0) // the oracle/goal-check verdict at the root NEVER emitted — the suite gated it
  })
})

describe("jh-improve4 P4 — bounded holistic re-derive escape", () => {
  // A foundation `bigint.c` whose mul is subtly wrong from the start: t_add and pi (which don't test mul)
  // build green and LINK bigint.c, so it is the most-linked source; the t_mul test keeps FAILING. After
  // REDERIVE_AFTER fix attempts the harness grows ONE from-scratch re-implementation of bigint.c (deepest
  // dependency, not the most-edited test file). The default reply keeps failing to drive the churn.
  const FAIL_MUL = atom({ tool: "run", args: { command: "gcc t_mul.c bigint.c -o t_mul.exe && ./t_mul.exe" }, check: { type: "run", command: "gcc t_mul.c bigint.c -o t_mul.exe && ./t_mul.exe", expect: "998001" } })
  const REDERIVE_REPLIES = [
    compound(["build phase"]),
    compound(["reg add", "build pi", "test mul"]),
    REGISTER_ADD, // t_add.exe links bigint.c (green)
    atom({ tool: "run", args: { command: "gcc pi.c bigint.c -o pi.exe && ./pi.exe" }, check: { type: "run", command: "gcc pi.c bigint.c -o pi.exe && ./pi.exe", expect: "3.14" } }), // pi.exe links bigint.c (green)
    atom({ tool: "write_file", args: { path: "t_mul.c", content: "test mul" }, check: { type: "run", command: "gcc t_mul.c bigint.c -o t_mul.exe && ./t_mul.exe", expect: "998001" } }), // the failing mul test
  ]
  const rederiveWorld = () => buildWorld({ initial: { "bigint.c": "lib v0 (mul subtly wrong)", "pi.c": "formula" }, programs: { "t_add.exe": addProgram, "pi.exe": () => ({ code: 0, output: "3.14" }), "t_mul.exe": mulProgram } })

  test("repeated failures on a foundation trigger a from-scratch re-derivation of the DEEPEST source (bigint.c), once, naming the file + test", async () => {
    const world = rederiveWorld()
    const prompts: string[] = []
    const deps = harness({ world, replies: REDERIVE_REPLIES, defaultReply: FAIL_MUL, onPrompt: (u) => prompts.push(u), limits: { maxDepth: 3, maxTotalSteps: 40 } })
    const r = await run(deps)
    const rd = log(r, "rederived") as Array<{ file: string }>
    expect(rd.length).toBe(1) // fired exactly ONCE (once per file per run)
    expect(rd[0]!.file).toBe("bigint.c") // the shared foundation, NOT the most-edited test file t_mul.c
    // the escape node's goal (seen when it is introspected) re-implements bigint.c from scratch and names its test
    expect(prompts.some((u) => u.includes("FRESH implementation of bigint.c") && u.includes("t_mul.exe"))).toBe(true)
  })

  test("flag-off (rederive:false): the same repeated failures NEVER grow a re-derive node", async () => {
    const world = rederiveWorld()
    const deps = harness({ world, rederive: false, replies: REDERIVE_REPLIES, defaultReply: FAIL_MUL, limits: { maxDepth: 3, maxTotalSteps: 40 } })
    const r = await run(deps)
    expect(has(r, "rederived")).toBe(false)
  })
})

describe("jh-improve5 P2 — transactional edit gate", () => {
  // root → [A compiles bigint.o via `gcc -c` (so staleness knows the per-file object compile), B edits bigint.c].
  const COMPILE_BIGINT = atom({ tool: "run", args: { command: "gcc -c bigint.c -o bigint.o" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
  const txWorld = () => buildWorld({ initial: { "bigint.c": "lib OK" }, programs: {} })

  test("the run89 fixture: a non-compiling edit is REJECTED at the door — file restored, workspace never un-green", async () => {
    const world = txWorld()
    const deps = harness({
      world,
      replies: [
        compound(["compile bigint", "break bigint"]),
        COMPILE_BIGINT,
        atom({ tool: "write_file", args: { path: "bigint.c", content: "lib BUILDERR now" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
      limits: { maxDepth: 2, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(log(r, "edit_rejected").map((e) => (e as { file: string }).file)).toContain("bigint.c")
    expect(world.files.get("bigint.c")).toBe("lib OK") // restored to the pre-image — byte-identical
    expect(verifDetails(r).some((d) => d.startsWith("edit NOT applied") && d.includes("bigint.c"))).toBe(true)
    expect(has(r, "reverted")).toBe(false) // prevented, never healed — auto-revert never engaged
  })

  test("a COMPILING edit is accepted (gate passes) and applied", async () => {
    const world = txWorld()
    const deps = harness({
      world,
      replies: [
        compound(["compile bigint", "improve bigint"]),
        COMPILE_BIGINT,
        atom({ tool: "write_file", args: { path: "bigint.c", content: "lib OK v2" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
      limits: { maxDepth: 2, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(has(r, "edit_rejected")).toBe(false)
    expect(world.files.get("bigint.c")).toBe("lib OK v2") // the good edit stuck
  })

  test("a file with NO known object-compile is ungated (opportunistic — accept)", async () => {
    const world = buildWorld({ initial: { "notes.txt": "hello" }, programs: {} })
    const deps = harness({
      world,
      replies: [atom({ tool: "write_file", args: { path: "notes.txt", content: "BUILDERR but not a compiled unit" }, check: { type: "artifact_present" } })],
      limits: { maxDepth: 0, maxTotalSteps: 8 },
    })
    const r = await run(deps)
    expect(has(r, "edit_rejected")).toBe(false) // no `-c` compile for notes.txt → gate skipped
    expect(world.files.get("notes.txt")).toBe("BUILDERR but not a compiled unit")
  })

  test("rejected edits do NOT accrue buildDamage → no auto-revert even after repeats", async () => {
    const world = txWorld()
    const brk = (v: string) => atom({ tool: "write_file", args: { path: "bigint.c", content: `lib BUILDERR ${v}` }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
    const deps = harness({
      world,
      autoRevert: true,
      replies: [compound(["compile", "break repeatedly"]), COMPILE_BIGINT, brk("a"), brk("b"), brk("c"), brk("d")],
      limits: { maxDepth: 2, maxTotalSteps: 20 },
    })
    const r = await run(deps)
    expect(log(r, "edit_rejected").length).toBeGreaterThanOrEqual(3)
    expect(has(r, "reverted")).toBe(false) // rejections aren't damage → buildDamage stays 0 → auto-revert never fires
  })

  test("flag-off (txEdits:false): the breaking edit is ACCEPTED (wave-4 heal-later behavior)", async () => {
    const world = txWorld()
    const deps = harness({
      world,
      txEdits: false,
      replies: [
        compound(["compile bigint", "break bigint"]),
        COMPILE_BIGINT,
        atom({ tool: "write_file", args: { path: "bigint.c", content: "lib BUILDERR now" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
      limits: { maxDepth: 2, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(has(r, "edit_rejected")).toBe(false) // no gate
    expect(world.files.get("bigint.c")).toBe("lib BUILDERR now") // the broken edit was accepted into the workspace
  })
})

describe("jh-improve4 P5 — opaque-crash routing to analyze", () => {
  // A leaf that RUNS a pre-built binary which CRASHES (non-zero exit, EMPTY stdout) — the executor narrates
  // a "runtime CRASH" with nothing to tweak. The ladder must jump straight to the ANALYZE (instrument)
  // stage. crash.exe is pre-seeded + never compiled here, so re-derive can't fire (no source chain); the
  // small budget means the ladder can't reach its natural count-4 analyze — any analyze directive is P5.
  const CRASH_LEAF = atom({ tool: "run", args: { command: "./crash.exe" }, check: { type: "run", command: "./crash.exe", expect: "impossible" } })

  test("an opaque crash (non-zero exit, no output) routes the FIRST grown fix straight to the analyze stage", async () => {
    const world = buildWorld({ initial: { "crash.exe": "prebuilt" }, programs: { "crash.exe": () => ({ code: 1, output: "" }) } })
    const prompts: string[] = []
    const deps = harness({ world, replies: [compound(["run the crashing step"]), CRASH_LEAF], defaultReply: CRASH_LEAF, onPrompt: (u) => prompts.push(u), limits: { maxDepth: 2, maxTotalSteps: 5 } })
    const r = await run(deps)
    // an analyze directive appeared despite the tiny budget → the crash routed to analyze, not blind tweaks
    expect(prompts.some((u) => u.includes("INSTRUMENT the program"))).toBe(true)
    expect(r.status).not.toBe("done")
  })

  test("parity: a crash WITH diagnostic output does NOT jump to analyze (the ladder tweaks first)", async () => {
    const world = buildWorld({ initial: { "crash.exe": "prebuilt" }, programs: { "crash.exe": () => ({ code: 1, output: "segfault at line 42: bad index" }) } })
    const prompts: string[] = []
    const deps = harness({ world, replies: [compound(["run the failing step"]), CRASH_LEAF], defaultReply: CRASH_LEAF, onPrompt: (u) => prompts.push(u), limits: { maxDepth: 2, maxTotalSteps: 5 } })
    const r = await run(deps)
    // with a non-empty failure detail the ladder is NOT crash-routed; within this tiny budget it never reaches analyze
    expect(prompts.some((u) => u.includes("INSTRUMENT the program"))).toBe(false)
  })
})
