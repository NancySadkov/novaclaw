import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// jh-improve6 — the harm-removal corrections, ENGINE integration. Two permanent fixtures encode the wave-5
// transcript evidence (the senior re-diagnosis in notes/jh-improve5-report.md):
//  · run104: the tx gate ran the recorded COMPOUND (build+TEST) as its "object compile" and rejected an
//    edit that compiled and passed 13/15 tests, 73×, with the FALSE message "does not compile". The gate
//    must run ONLY the compile segment; test-red edits LAND and report honestly.
//  · run101: a registered test that is itself WRONG was infallible by construction and pinned the endgame
//    29×. Tests are code too — suspicion, veto-loss, and a one-time test-fix node.
// The in-memory build world mirrors regression-engine.test.ts, with one addition: compile failures NAME the
// offending file (`x.c:1:1: error: BUILDERR`) the way a real compiler does — the suspect-test own-file
// detection reads diagnostics shape.

interface Program {
  (files: ReadonlyMap<string, string>): { readonly code: number; readonly output: string }
}

function buildWorld(opts: { initial: Record<string, string>; programs: Record<string, Program> }) {
  const files = new Map(Object.entries(opts.initial))
  let checkpoint = new Map(files)

  const base = (p: string): string => (p.replace(/^\.[/\\]/, "").split(/[/\\]/).pop() ?? p)

  const execProgram = (command: string): { code: number; output: string } => {
    const parts = command.split("&&").map((s) => s.trim())
    let output = ""
    for (const seg of parts) {
      if (/^set\s/i.test(seg) || /^export\s/.test(seg)) continue // env setup — a fresh-shell no-op here
      if (/(^|\s)gcc\b/.test(seg)) {
        const outMatch = seg.match(/-o\s+(\S+)/)
        const srcs = (seg.match(/\S+\.c\b/g) ?? []).map(base)
        const bad = srcs.find((s) => (files.get(s) ?? "").includes("BUILDERR"))
        if (bad) return { code: 1, output: `${output}${bad}:1:1: error: BUILDERR` } // compiler-shaped diagnostics
        if (outMatch) files.set(base(outMatch[1]!), `bin(${srcs.map((s) => `${s}:${files.get(s) ?? ""}`).join(";")})`)
        continue
      }
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

const compound = (goals: string[]) => JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: goals.map((goal) => ({ goal, size: "atomic", tool: "note", args: { text: "x" }, check: { type: "artifact_present" }, produces: [] })) })
const atom = (over: Record<string, unknown>) => JSON.stringify({ goal: "step", size: "atomic", success: "ok", produces: [], ...over })

function harness(opts: {
  world: ReturnType<typeof buildWorld>
  replies: string[]
  suspectTests?: boolean
  numericsHint?: string
  defaultReply?: string
  onPrompt?: (user: string) => void
  taskComplete?: JhEngine.Deps["taskComplete"]
  limits?: { maxDepth: number; maxTotalSteps: number }
}) {
  const replies = [...opts.replies]
  let i = 0
  const idle = opts.defaultReply ?? atom({ tool: "note", args: { text: "idle" }, check: { type: "artifact_present" } })
  const deps: JhEngine.Deps = {
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
    suspectTests: opts.suspectTests,
    numericsHint: opts.numericsHint,
    revertWorkspace: opts.world.revertWorkspace,
    checkpoint: opts.world.doCheckpoint,
    limits: opts.limits ?? { maxDepth: 3, maxTotalSteps: 24 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return deps
}

const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "compute Pi to 100 digits" }))
const log = (r: JhEngine.Report, t: string) => r.state.log.filter((e) => e.type === t)
const verifDetails = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail ?? ""))

// ---- the run104 world: a COMPOUND builds bigint.o + t_add.exe and runs the test; the test passes iff
// bigint.c still contains MAGIC; the compile only fails on BUILDERR. ----
const COMPOUND = "set PATH=C:/w64devkit/bin;%PATH% && gcc -c bigint.c -o bigint.o && gcc t_add.c bigint.o -o t_add.exe && ./t_add.exe"
const tAddProgram: Program = (f) => ((f.get("bigint.c") ?? "").includes("MAGIC") ? { code: 0, output: "PASS15" } : { code: 1, output: "FAIL: expected=4294967295 actual=99\nPASSED=13 FAILED=2" })
const SETUP = atom({ goal: "build and test add", tool: "run", args: { command: COMPOUND }, check: { type: "run", command: COMPOUND, expect: "PASS15" } })
const world104 = () => buildWorld({ initial: { "bigint.c": "lib MAGIC v1", "t_add.c": "test-src" }, programs: { "t_add.exe": tAddProgram } })

describe("jh-improve6 P1 — gate surgery", () => {
  test("run104 fixture: an edit that COMPILES but fails the test LANDS (no edit_rejected) and reports an honest fresh REGRESSION", async () => {
    const world = world104()
    const deps = harness({
      world,
      replies: [
        compound(["build & test add", "improve the formula"]),
        SETUP,
        atom({ goal: "improve", tool: "edit_file", args: { path: "bigint.c", old_string: "MAGIC", new_string: "NOMATCH" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
    })
    const r = await run(deps)
    expect(log(r, "edit_rejected").length).toBe(0) // the wave-5 gate rejected this 73× — it must LAND now
    expect(log(r, "regression").length).toBeGreaterThanOrEqual(1)
    const details = verifDetails(r)
    expect(details.some((d) => d.startsWith("REGRESSION: "))).toBe(true) // fresh break — truthful attribution
    expect(details.every((d) => !d.includes("does not compile"))).toBe(true) // the lie is gone
    expect(world.files.get("bigint.c")).toContain("NOMATCH") // the edit really landed
  })

  test("a TRUE compile error still rejects, with a truthful message and a byte-identical restore", async () => {
    const world = world104()
    const deps = harness({
      world,
      replies: [
        compound(["build & test add", "improve the formula"]),
        SETUP,
        atom({ goal: "improve", tool: "edit_file", args: { path: "bigint.c", old_string: "v1", new_string: "BUILDERR v1" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
    })
    const r = await run(deps)
    expect(log(r, "edit_rejected").length).toBeGreaterThanOrEqual(1)
    const rejects = verifDetails(r).filter((d) => d.includes("no longer compiles"))
    expect(rejects.length).toBeGreaterThanOrEqual(1)
    expect(rejects[0]).toContain("bigint.c:1:1: error") // the COMPILER's diagnostics, not test output
    expect(world.files.get("bigint.c")).toBe("lib MAGIC v1") // restored
  })

  test("the gate YIELDS after 3 consecutive rejections (across grown fix siblings) — one-shot-perfect is impossible", async () => {
    const world = world104()
    const breaking = atom({ goal: "fix", tool: "edit_file", args: { path: "bigint.c", old_string: "v1", new_string: "BUILDERR v1" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
    const deps = harness({
      world,
      replies: [compound(["build & test add", "improve the formula"]), SETUP, breaking],
      defaultReply: breaking, // every recovery/grown-sibling attempt retries the same damaging edit
    })
    const r = await run(deps)
    const rejects = log(r, "edit_rejected")
    const yields = log(r, "gate_yielded")
    expect(yields.length).toBeGreaterThanOrEqual(1)
    expect(rejects.length).toBeGreaterThanOrEqual(3)
    // the yield happens only AFTER the third rejection — the gate is a guardrail first, then steps aside.
    expect((yields[0] as { seq: number }).seq).toBeGreaterThan((rejects[2] as { seq: number }).seq)
  })
})

describe("jh-improve6 P2 — gradient-aware damage", () => {
  test("a STILL-failing suite round is 'REGRESSION SUITE:' (progress-neutral) and never triggers the revert machinery", async () => {
    const world = world104()
    const edit = (from: string, to: string) => atom({ goal: "improve", tool: "edit_file", args: { path: "bigint.c", old_string: from, new_string: to }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
    const deps = harness({
      world,
      replies: [compound(["build & test add", "improve the formula"]), SETUP, edit("MAGIC", "NOMATCH"), edit("v1", "v2"), edit("v2", "v3")],
    })
    const r = await run(deps)
    const details = verifDetails(r)
    expect(details.filter((d) => d.startsWith("REGRESSION: ")).length).toBe(1) // the one FRESH break
    expect(details.filter((d) => d.startsWith("REGRESSION SUITE: ")).length).toBeGreaterThanOrEqual(2) // then still-failing rounds
    expect(log(r, "reverted").length).toBe(0) // no damage accrual from still-red rounds
  })
})

describe("jh-improve6 P3 — suspect tests (tests are code too)", () => {
  const editSeq = ["MAGIC→NOMATCH", "v1→v2", "v2→v3", "v3→v4", "v4→v5"].map((s) => {
    const [from, to] = s.split("→") as [string, string]
    return atom({ goal: "improve", tool: "edit_file", args: { path: "bigint.c", old_string: from, new_string: to }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
  })

  test("a test red for SUSPECT_AFTER rounds (score non-regressing) becomes SUSPECT: fix node grown once, veto gone", async () => {
    const world = world104()
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["build & test add", "improve the formula"]), SETUP, ...editSeq],
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    const suspects = log(r, "suspect_test") as Array<{ command: string; seq: number }>
    expect(suspects.length).toBe(1)
    expect(suspects[0]!.command).toContain("t_add.exe")
    expect(prompts.some((u) => u.includes("Re-derive the TEST"))).toBe(true) // the one-time test-fix node
    // after suspicion, the suite never again vetoes on this test:
    const afterSeq = suspects[0]!.seq
    const laterRegressions = (r.state.log.filter((e) => e.type === "verification" && e.seq > afterSeq) as Array<{ detail?: string }>).filter((e) => String(e.detail ?? "").startsWith("REGRESSION"))
    expect(laterRegressions.length).toBe(0)
  })

  test("suspectTests: false — wave-5 behavior exactly (no suspicion, the still-failing test keeps vetoing)", async () => {
    const world = world104()
    const deps = harness({
      world,
      replies: [compound(["build & test add", "improve the formula"]), SETUP, ...editSeq],
      suspectTests: false,
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    expect(log(r, "suspect_test").length).toBe(0)
    expect(verifDetails(r).filter((d) => d.startsWith("REGRESSION")).length).toBeGreaterThanOrEqual(4)
  })

  test("a test whose OWN exclusive file fails to build is suspect immediately (run101's t_arctan shape)", async () => {
    // two tests: t_shared references only shared sources; t_only additionally references its own t_only.c.
    const world = buildWorld({
      initial: { "bigint.c": "lib MAGIC v1", "t_shared.c": "shared-test", "t_only.c": "only-test" },
      programs: { "t_shared.exe": () => ({ code: 0, output: "OK-SHARED" }), "t_only.exe": () => ({ code: 0, output: "OK-ONLY" }) },
    })
    const SHARED = "gcc t_shared.c bigint.c -o t_shared.exe && ./t_shared.exe"
    const ONLY = "gcc t_only.c bigint.c -o t_only.exe && ./t_only.exe"
    const deps = harness({
      world,
      replies: [
        compound(["shared test", "own test", "break the test file"]),
        atom({ goal: "shared", tool: "run", args: { command: SHARED }, check: { type: "run", command: SHARED, expect: "OK-SHARED" } }),
        atom({ goal: "own", tool: "run", args: { command: ONLY }, check: { type: "run", command: ONLY, expect: "OK-ONLY" } }),
        atom({ goal: "edit", tool: "edit_file", args: { path: "t_only.c", old_string: "only-test", new_string: "only BUILDERR" }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } }),
      ],
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    const suspects = log(r, "suspect_test") as Array<{ command: string }>
    expect(suspects.length).toBe(1)
    expect(suspects[0]!.command).toContain("t_only.exe")
    expect(verifDetails(r).filter((d) => d.startsWith("REGRESSION")).length).toBe(0) // never vetoed
  })

  test("an UNSANITIZED test (passed with implicit-declaration warnings) goes suspect on its FIRST failure", async () => {
    const world = buildWorld({
      initial: { "bigint.c": "lib MAGIC v1", "t_w.c": "warn-test" },
      programs: { "t_w.exe": (f) => ((f.get("bigint.c") ?? "").includes("MAGIC") ? { code: 0, output: "PASS (implicit declaration of function 'bigint_cmp')" } : { code: 1, output: "FAIL" }) },
    })
    const W = "gcc t_w.c bigint.c -o t_w.exe && ./t_w.exe"
    const edit = (from: string, to: string) => atom({ goal: "improve", tool: "edit_file", args: { path: "bigint.c", old_string: from, new_string: to }, check: { type: "compile", command: "gcc -c bigint.c -o bigint.o" } })
    const deps = harness({
      world,
      replies: [
        compound(["warned test", "harmless edit", "breaking edit"]),
        atom({ goal: "w", tool: "run", args: { command: W }, check: { type: "run", command: W, expect: "PASS" } }),
        edit("v1", "v2"), // harmless — sweep re-runs t_w GREEN with warnings → marked unsanitized
        edit("MAGIC", "GONE"), // first REAL failure → suspect immediately (no 4-round wait)
      ],
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    expect(log(r, "suspect_test").length).toBe(1)
    // it never got to a SUSPECT_AFTER streak — the fast path fired on failure #1:
    expect(verifDetails(r).filter((d) => d.startsWith("REGRESSION SUITE:")).length).toBe(0)
  })
})

describe("jh-improve6 P5 — targeted numerics", () => {
  test("a score plateau with a green build injects the caller's hint into the NEXT introspection (never unprompted)", async () => {
    const world = buildWorld({ initial: { "s.c": "src" }, programs: { "s.exe": () => ({ code: 0, output: "OK" }) } })
    const RUN = "gcc s.c -o s.exe && ./s.exe"
    const step = atom({ goal: "run it", tool: "run", args: { command: RUN }, check: { type: "run", command: RUN, expect: "OK" } })
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["a", "b", "c", "d", "e"]), step, step, step, step, step],
      numericsHint: "GUARD-DIGITS-HINT: carry extra precision and stop the series below the final precision.",
      taskComplete: () => ({ done: false, detail: "not done", score: 0.1 }),
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    expect(log(r, "numerics_hint").length).toBeGreaterThanOrEqual(1)
    const hintAt = prompts.findIndex((u) => u.includes("GUARD-DIGITS-HINT"))
    expect(hintAt).toBeGreaterThan(0) // delivered to a LATER working introspection, not the opening plan
    expect(prompts[0]).not.toContain("GUARD-DIGITS-HINT") // never in the planning prompt (the P6.1 regression)
  })
})
