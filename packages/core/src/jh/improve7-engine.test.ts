import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// jh-improve7 — keep the best, always + mandatory coordinates. Two permanent fixtures encode the wave-6
// residual (notes/jh-improve6-report.md §VERDICT):
//  · run112 (K5): the model HELD an 82-digit best (0.812) and ENDED the run on a 17-digit state — keep-best
//    only restored via escalation, and no terminal path restored. Now: restore-on-drop (2 consecutive
//    below-best samples) + a terminal restore on EVERY report path (the deliverable is the best state).
//  · run111 (C7): 23× `old_string not found` on bigint.c — the harness OFFERED coordinates but never
//    enforced them. Now: after COORD_AFTER consecutive misses a file locks to `replace_lines` (edit_file
//    intercepted pre-execution) until a successful edit lands.
// The in-memory build world mirrors improve6-engine.test.ts (compiler-shaped diagnostics), plus a
// line-based replace_lines so the coordinate path is exercisable.

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
      if (/^set\s/i.test(seg) || /^export\s/.test(seg)) continue
      if (/(^|\s)gcc\b/.test(seg)) {
        const outMatch = seg.match(/-o\s+(\S+)/)
        const srcs = (seg.match(/\S+\.c\b/g) ?? []).map(base)
        const bad = srcs.find((s) => (files.get(s) ?? "").includes("BUILDERR"))
        if (bad) return { code: 1, output: `${output}${bad}:1:1: error: BUILDERR` }
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
        return Effect.succeed({ ok, output: ok ? "edited" : `old_string not found in ${p} — the file's ACTUAL current content is shown in the context above`, artifacts: new Map<string, string>() })
      }
      if (tool === "replace_lines") {
        const p = base(String(args.path))
        const cur = files.get(p)
        if (cur === undefined) return Effect.succeed({ ok: false, output: `file not found: ${p}`, artifacts: new Map<string, string>() })
        const lines = cur.split("\n")
        const first = Number(args.first_line)
        const last = Number(args.last_line)
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last > lines.length || first > last)
          return Effect.succeed({ ok: false, output: `line range ${first}-${last} out of range`, artifacts: new Map<string, string>() })
        lines.splice(first - 1, last - first + 1, ...String(args.new_content).split("\n"))
        files.set(p, lines.join("\n"))
        return Effect.succeed({ ok: true, output: `replaced lines ${first}-${last} of ${p}`, artifacts: new Map<string, string>() })
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
  defaultReply?: string
  onPrompt?: (user: string) => void
  taskComplete?: JhEngine.Deps["taskComplete"]
  restoreOnDrop?: boolean
  coordMode?: boolean
  numericsHint?: string
  numericsHintFor?: JhEngine.Deps["numericsHintFor"]
  budget?: JhEngine.Deps["budget"]
  budgetAware?: boolean
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
    restoreOnDrop: opts.restoreOnDrop,
    coordMode: opts.coordMode,
    numericsHint: opts.numericsHint,
    numericsHintFor: opts.numericsHintFor,
    budget: opts.budget,
    budgetAware: opts.budgetAware,
    revertWorkspace: opts.world.revertWorkspace,
    checkpoint: opts.world.doCheckpoint,
    limits: opts.limits ?? { maxDepth: 3, maxTotalSteps: 24 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return deps
}

const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "compute the value" }))
const log = (r: JhEngine.Report, t: string) => r.state.log.filter((e) => e.type === t)
const restores = (r: JhEngine.Report, reason: string) => (log(r, "restored_best") as Array<{ reason: string }>).filter((e) => e.reason === reason)
const verifDetails = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail ?? ""))

// ---- the run112 world: s.exe reports a score derived from s.c; the graded oracle reads it off the last
// output. GOOD source → 0.8, anything else → 0.2. ----
const RUN = "gcc s.c -o s.exe && ./s.exe"
const scoreWorld = () =>
  buildWorld({
    initial: { "s.c": "prog GOOD v1" },
    programs: { "s.exe": (f) => ({ code: 0, output: (f.get("s.c") ?? "").includes("GOOD") ? "SCORE:8" : "SCORE:2" }) },
  })
const scoreOracle: JhEngine.Deps["taskComplete"] = ({ lastOutput }) => ({
  done: false,
  detail: "not done",
  score: lastOutput.includes("SCORE:8") ? 0.8 : lastOutput.includes("SCORE:2") ? 0.2 : 0,
})
const RUN_STEP = atom({ goal: "run it", tool: "run", args: { command: RUN }, check: { type: "run", command: RUN, expect: "SCORE" } })
const WORSEN = atom({ goal: "worsen", tool: "edit_file", args: { path: "s.c", old_string: "GOOD", new_string: "BAD" }, check: { type: "compile", command: "gcc -c s.c -o s.o" } })

describe("jh-improve7 P1 — K5 restore-on-drop", () => {
  test("run112 fixture: two consecutive below-best samples restore the best snapshot mid-run (reason: drop)", async () => {
    const world = scoreWorld()
    const deps = harness({
      world,
      replies: [compound(["run", "worsen", "run", "run"]), RUN_STEP, WORSEN, RUN_STEP, RUN_STEP],
      taskComplete: scoreOracle,
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    const drops = restores(r, "drop")
    expect(drops.length).toBeGreaterThanOrEqual(1)
    expect(world.files.get("s.c")).toContain("GOOD") // the 0.8 source is back on disk
  })

  test("ONE below-best sample does not restore (the model may be mid-repair)", async () => {
    const world = scoreWorld()
    const deps = harness({
      world,
      replies: [compound(["run", "worsen", "run"]), RUN_STEP, WORSEN, RUN_STEP],
      taskComplete: scoreOracle,
      restoreOnDrop: undefined,
      limits: { maxDepth: 3, maxTotalSteps: 12 },
    })
    const r = await run(deps)
    expect(restores(r, "drop").length).toBe(0)
  })

  test("a best below RESTORE_FLOOR never drop-restores (restoring a 0.03 state is churn)", async () => {
    const world = buildWorld({
      initial: { "s.c": "prog GOOD v1" },
      programs: { "s.exe": (f) => ({ code: 0, output: (f.get("s.c") ?? "").includes("GOOD") ? "SCORE:8" : "SCORE:2" }) },
    })
    const tinyOracle: JhEngine.Deps["taskComplete"] = ({ lastOutput }) => ({ done: false, detail: "nd", score: lastOutput.includes("SCORE:8") ? 0.08 : 0.02 })
    const deps = harness({
      world,
      replies: [compound(["run", "worsen", "run", "run"]), RUN_STEP, WORSEN, RUN_STEP, RUN_STEP],
      taskComplete: tinyOracle,
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    expect(restores(r, "drop").length).toBe(0)
  })

  test("restoreOnDrop: false — no mid-run drop restore (the terminal restore still delivers the best state)", async () => {
    const world = scoreWorld()
    const deps = harness({
      world,
      replies: [compound(["run", "worsen", "run", "run"]), RUN_STEP, WORSEN, RUN_STEP, RUN_STEP],
      taskComplete: scoreOracle,
      restoreOnDrop: false,
      limits: { maxDepth: 3, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(restores(r, "drop").length).toBe(0)
    expect(restores(r, "final").length).toBe(1)
    expect(world.files.get("s.c")).toContain("GOOD")
  })
})

describe("jh-improve7 P1 — K5 terminal restore + wall-stop", () => {
  test("a run that ends on a regressed workspace delivers the BEST state (reason: final)", async () => {
    const world = scoreWorld()
    const deps = harness({
      world,
      // best 0.8, one worsening edit, ONE bad sample (below the drop threshold) — then the run exhausts.
      replies: [compound(["run", "worsen", "run"]), RUN_STEP, WORSEN, RUN_STEP],
      taskComplete: scoreOracle,
      restoreOnDrop: false,
      limits: { maxDepth: 3, maxTotalSteps: 12 },
    })
    const r = await run(deps)
    expect(r.status).toBe("blocked")
    expect(restores(r, "final").length).toBe(1)
    expect(world.files.get("s.c")).toContain("GOOD")
  })

  test("a clean DONE at the best score does not restore (nothing to un-do)", async () => {
    const world = scoreWorld()
    const doneOracle: JhEngine.Deps["taskComplete"] = ({ lastOutput }) => ({ done: lastOutput.includes("SCORE:8"), detail: "d", score: lastOutput.includes("SCORE:8") ? 0.8 : 0.2 })
    const deps = harness({
      world,
      replies: [compound(["run"]), RUN_STEP],
      taskComplete: doneOracle,
      limits: { maxDepth: 3, maxTotalSteps: 12 },
    })
    const r = await run(deps)
    expect(r.status).toBe("done")
    expect(log(r, "restored_best").length).toBe(0)
  })

  test("the wall can expire MID-LEAF: an endless exploration loop still exits through the terminal restore", async () => {
    // probe-11550 shape: a leaf rut (its check keeps failing) runs past the wall without returning to the
    // scheduler — pre-fix, only the harness's backstop race could end it, skipping the best-restore.
    const world = scoreWorld()
    // Event-driven clock (the in-leaf check consumes now() calls, so call-counting is brittle): time
    // stays far from the wall until the WORSEN edit is on disk, then crosses a few calls later — i.e.
    // mid-rut, inside the endless leaf.
    let clock = 0
    let afterWorsen = 0
    const MISS_FOREVER = atom({ goal: "fix", tool: "edit_file", args: { path: "s.c", old_string: "NO-SUCH", new_string: "y" }, check: { type: "artifact_present" } })
    const deps = harness({
      world,
      // run → worsen → run (the regression gets MEASURED — a restore is score-keyed) → the endless rut.
      replies: [compound(["run", "worsen", "run", "rut"]), RUN_STEP, WORSEN, RUN_STEP, MISS_FOREVER],
      defaultReply: MISS_FOREVER, // the leaf never passes — pre-fix it would spin to its own budget only
      taskComplete: scoreOracle,
      restoreOnDrop: false,
      coordMode: false, // keep the rut pure edit-miss (coord interception has its own tests)
      budget: { startedAt: 0, wallMs: 1_000_000, now: () => ((world.files.get("s.c") ?? "").includes("BAD") && ++afterWorsen > 6 ? 2_000_000 : (clock += 1)) },
      budgetAware: false,
      limits: { maxDepth: 3, maxTotalSteps: 64 },
    })
    const r = await run(deps)
    expect(r.reason).toBe("wall_exhausted")
    expect(restores(r, "final").length).toBe(1)
    expect(world.files.get("s.c")).toContain("GOOD")
  })

  test("engine wall-stop: exhaustion exits through the terminal restore (wall_exhausted, best delivered)", async () => {
    const world = scoreWorld()
    // Event-driven clock: crosses the wall only after the worsening edit AND its below-best run sample
    // exist (the run replies exhaust into idle notes; the wall then ends the run through the restore).
    let clock = 0
    let afterWorsen = 0
    const deps = harness({
      world,
      replies: [compound(["run", "worsen", "run"]), RUN_STEP, WORSEN, RUN_STEP],
      taskComplete: scoreOracle,
      restoreOnDrop: false,
      budget: { startedAt: 0, wallMs: 1_000_000, now: () => ((world.files.get("s.c") ?? "").includes("BAD") && ++afterWorsen > 12 ? 2_000_000 : (clock += 1)) },
      budgetAware: false, // isolate the wall-stop from the 50%/75% steers (their own tests exist)
      limits: { maxDepth: 3, maxTotalSteps: 64 },
    })
    const r = await run(deps)
    expect(r.reason).toBe("wall_exhausted")
    expect(restores(r, "final").length).toBe(1)
    expect(world.files.get("s.c")).toContain("GOOD")
  })
})

// ---- the run111 world: the model keeps mis-quoting lib.c. ----
const MISS = atom({ goal: "fix lib", tool: "edit_file", args: { path: "lib.c", old_string: "NO-SUCH-TEXT", new_string: "y" }, check: { type: "artifact_present" } })

describe("jh-improve7 P2 — C7 coord-mode", () => {
  test("run111 fixture: after 3 consecutive misses the file locks to coordinates (edit_file intercepted)", async () => {
    const world = buildWorld({ initial: { "lib.c": "line1\nline2\nline3" }, programs: {} })
    const deps = harness({
      world,
      replies: [compound(["fix lib"]), MISS],
      defaultReply: MISS, // the recovery keeps retrying the same mis-quote (the run111 shape)
      limits: { maxDepth: 3, maxTotalSteps: 12 },
    })
    const r = await run(deps)
    const locks = log(r, "coord_mode") as Array<{ file: string }>
    expect(locks.length).toBe(1)
    expect(locks[0]!.file).toBe("lib.c")
    const details = verifDetails(r)
    // exactly COORD_AFTER real misses executed; every later edit_file was intercepted with the redirect.
    expect(details.filter((d) => d.startsWith("old_string not found in lib.c")).length).toBe(3)
    const intercepts = details.filter((d) => d.includes("edit_file is DISABLED for lib.c"))
    expect(intercepts.length).toBeGreaterThanOrEqual(1)
    expect(intercepts[0]).toContain("replace_lines")
  })

  test("a successful edit resets the miss count (2 misses + hit + 2 misses = no lock)", async () => {
    const world = buildWorld({ initial: { "lib.c": "line1\nline2\nline3" }, programs: {} })
    const HIT = atom({ goal: "fix lib", tool: "edit_file", args: { path: "lib.c", old_string: "line2", new_string: "line2fixed" }, check: { type: "artifact_present" } })
    const deps = harness({
      world,
      replies: [compound(["m", "m", "h", "m", "m"]), MISS, MISS, HIT, MISS, MISS],
      limits: { maxDepth: 3, maxTotalSteps: 24 },
    })
    const r = await run(deps)
    expect(log(r, "coord_mode").length).toBe(0)
  })

  test("a successful replace_lines UNLOCKS the file (edit_file executes again)", async () => {
    const world = buildWorld({ initial: { "lib.c": "line1\nline2\nline3" }, programs: {} })
    const COORD = atom({ goal: "fix lib", tool: "replace_lines", args: { path: "lib.c", first_line: 2, last_line: 2, new_content: "line2fixed" }, check: { type: "artifact_present" } })
    const deps = harness({
      world,
      replies: [compound(["m", "m", "m", "coord", "m"]), MISS, MISS, MISS, COORD, MISS],
      limits: { maxDepth: 3, maxTotalSteps: 24 },
    })
    const r = await run(deps)
    expect(log(r, "coord_mode").length).toBe(1)
    expect(world.files.get("lib.c")).toContain("line2fixed") // the coordinate edit landed
    const details = verifDetails(r)
    // 3 pre-lock misses + at least 1 post-unlock EXECUTED miss (not intercepted)
    expect(details.filter((d) => d.startsWith("old_string not found in lib.c")).length).toBeGreaterThanOrEqual(4)
  })

  test("coordMode: false — wave-6 behavior exactly (misses keep executing, no interception)", async () => {
    const world = buildWorld({ initial: { "lib.c": "line1\nline2\nline3" }, programs: {} })
    const deps = harness({
      world,
      replies: [compound(["fix lib"]), MISS],
      defaultReply: MISS,
      coordMode: false,
      limits: { maxDepth: 3, maxTotalSteps: 12 },
    })
    const r = await run(deps)
    expect(log(r, "coord_mode").length).toBe(0)
    const details = verifDetails(r)
    expect(details.filter((d) => d.startsWith("old_string not found in lib.c")).length).toBeGreaterThan(3)
    expect(details.some((d) => d.includes("edit_file is DISABLED"))).toBe(false)
  })
})

describe("jh-improve7 P3 — K4 numericsHintFor", () => {
  test("the caller-formatted directive is preferred over the static text and carries the measured score", async () => {
    const world = buildWorld({ initial: { "s.c": "src" }, programs: { "s.exe": () => ({ code: 0, output: "OK" }) } })
    const R = "gcc s.c -o s.exe && ./s.exe"
    const step = atom({ goal: "run it", tool: "run", args: { command: R }, check: { type: "run", command: R, expect: "OK" } })
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["a", "b", "c", "d", "e"]), step, step, step, step, step],
      numericsHint: "STATIC-HINT",
      numericsHintFor: ({ bestScore }) => `PRECISE-HINT: correct to ~${Math.round(bestScore * 100)} digits — raise terms and guard digits`,
      taskComplete: () => ({ done: false, detail: "not done", score: 0.42 }),
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 32 },
    })
    const r = await run(deps)
    expect(log(r, "numerics_hint").length).toBeGreaterThanOrEqual(1)
    expect(prompts.some((u) => u.includes("PRECISE-HINT: correct to ~42 digits"))).toBe(true)
    expect(prompts.every((u) => !u.includes("STATIC-HINT"))).toBe(true)
    expect(prompts[0]).not.toContain("PRECISE-HINT") // never the planning prompt (the P6.1 regression guard)
  })
})
