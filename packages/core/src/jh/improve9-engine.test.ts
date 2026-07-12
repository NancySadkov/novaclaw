import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import type { JhProcessRunner } from "./process-runner"
import { JhEngine } from "./engine"

// jh-improve9 — the oracle speaks WHEN IT KNOWS. Fixtures encode the run136 anatomy
// (notes/jh-improve9.md): the oracle scored 1.0 with done=false ("fix the PRINTING") at event [287]
// and the verdict was never delivered (root completion never ran); the run then ended mid-library-
// surgery with trailing UNVERIFIED edits invisible to the score.

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
  taskComplete?: JhEngine.Deps["taskComplete"]
  oracleHint?: boolean
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
    oracleHint: opts.oracleHint,
    limits: opts.limits ?? { maxDepth: 3, maxTotalSteps: 24 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return deps
}

const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "compute and print the value" }))
const log = (r: JhEngine.Report, t: string) => r.state.log.filter((e) => e.type === t)

// ---- the run136 world: s.exe prints the value; the ORACLE distinguishes computed-right (score 1)
// from formatted-right (done). s.c with FORMATTED prints "3.14"; otherwise "314" (digits, no point). ----
const RUN = "gcc s.c -o s.exe && ./s.exe"
const RUN_STEP = atom({ goal: "run it", tool: "run", args: { command: RUN }, check: { type: "run", command: RUN, expect: "14" } })
const d5World = () =>
  buildWorld({
    initial: { "s.c": "prog DIGITS v1" },
    programs: { "s.exe": (f) => ({ code: 0, output: (f.get("s.c") ?? "").includes("FORMATTED") ? "3.14" : (f.get("s.c") ?? "").includes("DIGITS") ? "314" : "xx" }) },
  })
const d5Oracle: JhEngine.Deps["taskComplete"] = ({ lastOutput }) => {
  if (lastOutput.includes("3.14")) return { done: true, detail: "", score: 1 }
  if (lastOutput.includes("314")) return { done: false, score: 1, detail: "every digit is present IN ORDER — only the decimal point is missing; fix the PRINTING, not the math." }
  return { done: false, score: 0, detail: "wrong value" }
}

describe("jh-improve9 P1a — the near-done oracle directive", () => {
  test("run136 fixture: score 1.0 with done=false delivers the oracle's verdict to the NEXT introspection", async () => {
    const world = d5World()
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["run", "more work"]), RUN_STEP],
      taskComplete: d5Oracle,
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(log(r, "oracle_hint").length).toBeGreaterThanOrEqual(1)
    const at = prompts.findIndex((u) => u.includes("fix the PRINTING, not the math"))
    expect(at).toBeGreaterThan(0) // delivered to a later working introspection
    expect(prompts[at]).toContain("ONE SMALL FIX")
  })

  test("one-shot per episode: the directive is not re-injected while the score stays in the band", async () => {
    const world = d5World()
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["run", "again", "again2"]), RUN_STEP, RUN_STEP, RUN_STEP],
      taskComplete: d5Oracle,
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 20 },
    })
    const r = await run(deps)
    expect(log(r, "oracle_hint").length).toBe(1)
    // count the ORACLE BLOCK, not the raw detail — the detail legitimately recurs via verify-fail text.
    expect(prompts.filter((u) => u.includes("ONE SMALL FIX")).length).toBe(1)
  })

  test("oracleHint: false — no delivery (wave-8 behavior)", async () => {
    const world = d5World()
    const prompts: string[] = []
    const deps = harness({
      world,
      replies: [compound(["run", "more"]), RUN_STEP],
      taskComplete: d5Oracle,
      oracleHint: false,
      onPrompt: (u) => prompts.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 16 },
    })
    const r = await run(deps)
    expect(log(r, "oracle_hint").length).toBe(0)
    expect(prompts.some((u) => u.includes("fix the PRINTING"))).toBe(false)
  })
})

describe("jh-improve9 P1b — the oracle-done short-circuit", () => {
  test("a done=true sample ends the run at the next loop top, leaving sibling scaffolding unvisited", async () => {
    const world = d5World()
    world.files.set("s.c", "prog FORMATTED v1") // the program already prints 3.14
    const noteCalls: string[] = []
    const deps = harness({
      world,
      replies: [
        compound(["run", "scaffold-a", "scaffold-b", "scaffold-c"]),
        RUN_STEP,
        atom({ goal: "scaffold-a", tool: "note", args: { text: "SCAFFOLD-A" }, check: { type: "artifact_present" } }),
      ],
      taskComplete: d5Oracle,
      onPrompt: (u) => noteCalls.push(u),
      limits: { maxDepth: 3, maxTotalSteps: 24 },
    })
    const r = await run(deps)
    expect(r.status).toBe("done")
    expect(log(r, "oracle_done").length).toBe(1)
    // the scaffolding siblings were never introspected (the short-circuit fired before them)
    expect(noteCalls.filter((u) => u.includes("scaffold-b")).length).toBe(0)
  })
})

describe("jh-improve9 P2 — verified-state finalize", () => {
  test("run136-tail fixture: trailing UNVERIFIED edits to a best-snapshot file are restored at the wall", async () => {
    const world = d5World()
    // best sample lands (score 1, done=false), then an edit that BREAKS the source and keeps FAILING
    // its check (never re-sampled by a run) — the tail is unverified surgery.
    const BREAK = atom({ goal: "surgery", tool: "edit_file", args: { path: "s.c", old_string: "DIGITS", new_string: "BUILDERR DIGITS" }, check: { type: "compile", command: "gcc -c s.c -o s.o" } })
    const MISS = atom({ goal: "surgery", tool: "edit_file", args: { path: "s.c", old_string: "NO-SUCH", new_string: "x" }, check: { type: "artifact_present" } })
    const deps = harness({
      world,
      replies: [compound(["run", "surgery"]), RUN_STEP, BREAK],
      defaultReply: MISS, // keeps failing, never a successful run sample
      taskComplete: d5Oracle,
      limits: { maxDepth: 3, maxTotalSteps: 10 },
    })
    const r = await run(deps)
    expect(r.status).toBe("blocked")
    expect(world.files.get("s.c")).toBe("prog DIGITS v1") // the VERIFIED best state, not the surgery tail
    expect((log(r, "restored_best") as Array<{ reason: string }>).filter((e) => e.reason === "final").length).toBeGreaterThanOrEqual(1)
  })

  test("a verified-GREEN tail is never overwritten", async () => {
    const world = d5World()
    // the edit lands AND its compile check passes (verified) — no run re-sample, but the tail is green.
    const GREEN_EDIT = atom({ goal: "tweak", tool: "edit_file", args: { path: "s.c", old_string: "v1", new_string: "v2" }, check: { type: "compile", command: "gcc -c s.c -o s.o" } })
    const deps = harness({
      world,
      replies: [compound(["run", "tweak"]), RUN_STEP, GREEN_EDIT],
      taskComplete: d5Oracle,
      limits: { maxDepth: 3, maxTotalSteps: 8 },
    })
    const r = await run(deps)
    expect(world.files.get("s.c")).toBe("prog DIGITS v2") // the green edit SURVIVES
    expect((log(r, "restored_best") as Array<{ reason: string }>).filter((e) => e.reason === "final").length).toBe(0)
  })
})
