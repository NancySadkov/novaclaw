import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// jh-improve10 — tests are code too, from BIRTH (§K6). Fixtures encode the wave-9 arm anatomy:
//  · run138/139: an UNREGISTERED test with hand-computed WRONG expected values fails BYTE-IDENTICALLY
//    across changing source — invisible to improve6 suspicion (the registration hole) → never-green
//    suspicion grows a re-derive-the-TEST sibling.
//  · run140: 17 cumulative old_string misses on one file, zero locks (interleaved successes reset the
//    consecutive counter) → the cumulative lock is sticky at COORD_CUMULATIVE.

interface Program {
  (files: ReadonlyMap<string, string>): { readonly code: number; readonly output: string }
}

function buildWorld(opts: { initial: Record<string, string>; programs: Record<string, Program> }) {
  const files = new Map(Object.entries(opts.initial))
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
        return Effect.succeed({ ok, output: ok ? "edited" : `old_string not found in ${p} — see the context above`, artifacts: new Map<string, string>() })
      }
      const r = execProgram(String(args.command))
      return Effect.succeed({ ok: r.code === 0, output: r.output, artifacts: new Map<string, string>() })
    },
  }
  const listFiles = () => [...files].map(([name, content]) => ({ name, content }))
  return { files, runner, executor, listFiles }
}

const compound = (goals: string[]) => JSON.stringify({ goal: "root", size: "needs_decomposition", success: "ok", substeps: goals.map((goal) => ({ goal, size: "atomic", tool: "note", args: { text: "x" }, check: { type: "artifact_present" }, produces: [] })) })
const atom = (over: Record<string, unknown>) => JSON.stringify({ goal: "step", size: "atomic", success: "ok", produces: [], ...over })

function harness(opts: {
  world: ReturnType<typeof buildWorld>
  replies: string[]
  defaultReply?: string
  onPrompt?: (user: string) => void
  neverGreen?: boolean
  aborted?: () => boolean
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
    taskComplete: () => ({ done: false, detail: "not done" }),
    neverGreen: opts.neverGreen,
    aborted: opts.aborted,
    limits: opts.limits ?? { maxDepth: 3, maxTotalSteps: 32 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return deps
}

const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "make the test pass" }))
const log = (r: JhEngine.Report, t: string) => r.state.log.filter((e) => e.type === t)

// ---- the run138/139 world: t.exe embodies a WRONG hand-computed expectation — it fails with the SAME
// output no matter how prog.c changes (the program is effectively correct; the oracle is not). ----
const CHECK_CMD = "gcc t.c prog.c -o t.exe && ./t.exe"
const RUN_STEP = atom({ goal: "build and test", tool: "run", args: { command: CHECK_CMD }, check: { type: "run", command: CHECK_CMD, expect: "PASS" }, difficulty_prior: "hard" })
const editStep = (from: string, to: string) => atom({ goal: "fix prog", tool: "edit_file", args: { path: "prog.c", old_string: from, new_string: to }, check: { type: "run", command: CHECK_CMD, expect: "PASS" }, difficulty_prior: "hard" })
const wrongOracleWorld = () =>
  buildWorld({
    initial: { "prog.c": "prog v1", "t.c": "test expects THREE" },
    programs: { "t.exe": () => ({ code: 1, output: "FAIL: expected 3 got 2" }) }, // byte-identical, forever
  })

describe("jh-improve10 P1 — never-green suspicion (§K6)", () => {
  test("run138 fixture: identical failure across changing source grows ONE re-derive-the-TEST sibling", async () => {
    const world = wrongOracleWorld()
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["build and test"]), RUN_STEP, editStep("v1", "v2"), editStep("v2", "v3"), editStep("v3", "v4"), editStep("v4", "v5")],
      onPrompt: (u) => prompts.push(u),
    })
    const r = await run(deps)
    const events = log(r, "test_never_green") as Array<{ command: string }>
    expect(events.length).toBe(1)
    expect(events[0]!.command).toContain("t.exe")
    expect(prompts.some((u) => u.includes("Re-derive the TEST, not the source"))).toBe(true)
  })

  test("a CHANGING failure detail resets the streak — no suspicion", async () => {
    let n = 0
    const world = buildWorld({
      initial: { "prog.c": "prog v1", "t.c": "test" },
      programs: { "t.exe": () => ({ code: 1, output: `FAIL: attempt ${++n}` }) }, // evolving detail = real progress signal
    })
    const deps = harness({
      world,
      replies: [compound(["build and test"]), RUN_STEP, editStep("v1", "v2"), editStep("v2", "v3"), editStep("v3", "v4"), editStep("v4", "v5")],
    })
    const r = await run(deps)
    expect(log(r, "test_never_green").length).toBe(0)
  })

  test("a REGISTERED (once-green) test is excluded — improve6 suspicion owns it", async () => {
    // passes on the first run (registers), then fails identically forever once prog.c reaches v2+.
    const world = buildWorld({
      initial: { "prog.c": "prog v1", "t.c": "test" },
      programs: { "t.exe": (f) => ((f.get("prog.c") ?? "").includes("v1") ? { code: 0, output: "PASS" } : { code: 1, output: "FAIL: expected 3 got 2" }) },
    })
    const deps = harness({
      world,
      replies: [
        compound(["build and test", "keep editing"]),
        RUN_STEP, // passes on v1 → the test REGISTERS
        editStep("v1", "v2"),
        editStep("v2", "v3"),
        editStep("v3", "v4"),
        editStep("v4", "v5"),
      ],
    })
    const r = await run(deps)
    expect(log(r, "test_never_green").length).toBe(0)
  })

  test("neverGreen: false — wave-9 behavior exactly", async () => {
    const world = wrongOracleWorld()
    const deps = harness({
      world,
      replies: [compound(["build and test"]), RUN_STEP, editStep("v1", "v2"), editStep("v2", "v3"), editStep("v3", "v4"), editStep("v4", "v5")],
      neverGreen: false,
    })
    const r = await run(deps)
    expect(log(r, "test_never_green").length).toBe(0)
  })
})

describe("jh-improve11 P1 — the cooperative abort seam (racing)", () => {
  test("aborted mid-run: exits through the normal terminal path with reason 'aborted', mid-leaf included", async () => {
    const world = buildWorld({ initial: { "lib.c": "v1" }, programs: {} })
    const MISS = atom({ goal: "m", tool: "edit_file", args: { path: "lib.c", old_string: "NO-SUCH", new_string: "x" }, check: { type: "artifact_present" }, difficulty_prior: "hard" })
    let calls = 0
    const deps = harness({
      world,
      replies: [compound(["endless"]), MISS],
      defaultReply: MISS, // an endless leaf — only the abort can end it early
      onPrompt: () => {
        calls++
      },
      aborted: () => calls >= 4, // flip mid-leaf
      limits: { maxDepth: 3, maxTotalSteps: 64 },
    })
    const r = await run(deps)
    expect(r.status).toBe("blocked")
    expect(r.reason).toBe("aborted")
    expect(calls).toBeLessThan(10) // it stopped promptly, not at the step budget
  })
})

describe("jh-improve10 P2 — the cumulative (sticky) drift-lock", () => {
  test("run140 fixture: interleaved miss/success evades the consecutive counter but trips the cumulative lock", async () => {
    const world = buildWorld({ initial: { "lib.c": "alpha beta gamma delta epsilon zeta eta v1" }, programs: {} })
    const MISS = atom({ goal: "m", tool: "edit_file", args: { path: "lib.c", old_string: "NO-SUCH", new_string: "x" }, check: { type: "artifact_present" } })
    const hit = (from: string, to: string) => atom({ goal: "h", tool: "edit_file", args: { path: "lib.c", old_string: from, new_string: to }, check: { type: "artifact_present" } })
    // 6 misses, each separated by a successful edit — the consecutive counter never reaches 3.
    const deps = harness({
      world,
      replies: [
        compound(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"]),
        MISS, hit("alpha", "A"), MISS, hit("beta", "B"), MISS, hit("gamma", "C"), MISS, hit("delta", "D"), MISS, hit("epsilon", "E"), MISS, hit("zeta", "F"),
      ],
      defaultReply: MISS,
      limits: { maxDepth: 3, maxTotalSteps: 40 },
    })
    const r = await run(deps)
    expect(log(r, "coord_mode").length).toBe(1) // the STICKY cumulative lock fired
    const details = r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail ?? ""))
    expect(details.filter((d) => d.startsWith("old_string not found in lib.c")).length).toBe(6) // misses 7+ were intercepted
    expect(details.some((d) => d.includes("edit_file is DISABLED for lib.c"))).toBe(true)
  })
})
