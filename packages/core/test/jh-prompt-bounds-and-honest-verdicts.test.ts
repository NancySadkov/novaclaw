import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "../src/jh/artifact"
import { JhBudget } from "../src/jh/budget"
import { JhBasicTools } from "../src/jh/tools-basic"
import { JhEngine } from "../src/jh/engine"
import { Token } from "../src/util/token"

// Three invariants of the Strict prompt path, all of them the harness telling the truth about what it
// did and what it can do:
//
//  1. THE WORKSPACE RENDER HAS A TOTAL. The per-file cap and the file-COUNT cap bound two different
//     dimensions and MULTIPLY, so a 24-file working directory of 24,000-char files renders to ~600,000
//     characters — several times the honored window of the local models this harness exists to serve —
//     and it travels as ONE user message, the shape context-packing is inert against (a lone message is
//     both anchor and newest, so nothing is droppable and `dropped` stays 0). The probes below PRINT the
//     unbudgeted size and assert it crosses the window before asserting the budget holds it.
//  2. A VERIFIER THAT COULD NOT RUN HAS NOT VERIFIED. A failed goal-check call must not report the goal
//     achieved — on the default Strict path this verdict IS the completion authority.
//  3. THE TOOL VOCABULARY IS A CONSTRAINT. A tool the caller withdrew must be neither advertised in the
//     recovery directive nor executed when the model names it anyway.

// ── the probe workspace: exactly what production caps allow (FILE_LIST_CAP files, over the per-file cap)
const bigFile = (n: number): string =>
  Array.from({ length: 600 }, (_, i) => `line ${i} of file ${n} ${"x".repeat(30)}`).join("\n")
const workspace24 = (): Array<{ name: string; content: string }> =>
  Array.from({ length: 24 }, (_, i) => ({ name: `file${i}.c`, content: bigFile(i) }))

const OPTS = { numbered: true, fullFiles: true } as const

describe("the workspace render is budgeted against the model's context window", () => {
  test("🔴 the probe CROSSES the threshold: 24 files render past 4× a 32K window before any budget", () => {
    const unbudgeted = JhEngine.renderFiles(workspace24(), OPTS, Number.MAX_SAFE_INTEGER)
    const windowChars = Token.charsFromTokens(32_768)
    console.log(
      `[workspace] unbudgeted = ${unbudgeted.length} chars ≈ ${Math.round(Token.estimate(unbudgeted))} tokens; a 32K window is ${windowChars} chars`,
    )
    // A bound that was never exceeded proves nothing about the bound.
    expect(unbudgeted.length).toBeGreaterThan(4 * windowChars)
  })

  test("the budgeted render fits, names its omission, and keeps the most-recently-modified files", () => {
    const budget = JhEngine.workspaceCharBudget(32_768)
    const out = JhEngine.renderFiles(workspace24(), OPTS, budget)
    console.log(`[workspace] budget = ${budget} chars; budgeted = ${out.length} chars`)
    expect(out.length).toBeLessThanOrEqual(budget)
    // Files arrive most-recently-modified first, so the head survives and the TAIL is what goes.
    expect(out).toContain("### file0.c")
    expect(out).not.toContain("### file23.c")
    expect(out).toContain("file block(s) omitted") // no silent caps
  })

  test("the budget TRACKS the window rather than being a second magic number", () => {
    const files = workspace24()
    const small = JhEngine.renderFiles(files, OPTS, JhEngine.workspaceCharBudget(32_768))
    const large = JhEngine.renderFiles(files, OPTS, JhEngine.workspaceCharBudget(131_072))
    console.log(`[workspace] 32K window → ${small.length} chars; 128K window → ${large.length} chars`)
    expect(large.length).toBeGreaterThan(small.length)
    expect(large.length).toBeLessThanOrEqual(JhEngine.workspaceCharBudget(131_072))
    // An unknown or nonsense window gets the conservative assumption, never an unbounded one.
    expect(JhEngine.workspaceCharBudget(undefined)).toBe(JhEngine.workspaceCharBudget(32_768))
    expect(JhEngine.workspaceCharBudget(0)).toBe(JhEngine.workspaceCharBudget(32_768))
  })

  test("ONE file bigger than the whole budget is elided, never dropped — the edited file stays visible", () => {
    const huge = [{ name: "pi.c", content: bigFile(0) }]
    const budget = 3_000
    const out = JhEngine.renderFiles(huge, OPTS, budget)
    console.log(`[workspace] single file raw = ${huge[0]!.content.length} chars → ${out.length} at budget ${budget}`)
    expect(out.length).toBeLessThanOrEqual(budget)
    expect(out).toContain("### pi.c")
    expect(out).toContain("omitted") // the NAMED line-range elision, not a bare truncation
  })
})

// ── the engine end-to-end: what actually reaches the model ─────────────────────────────────────────
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
/** Every user prompt the engine hands the model, plus the tools the executor was actually asked to run. */
function probe(opts: {
  readonly contextTokens?: number
  readonly toolNames?: ReadonlyArray<string>
  readonly step?: () => string
  readonly goalCheck?: () => Effect.Effect<string, JhEngine.LLMFail>
  readonly runnerExit?: number
  readonly rootDecompose?: boolean
  readonly maxDepth?: number
  readonly maxTotalSteps?: number
}) {
  const prompts: string[] = []
  const executed: string[] = []
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      prompts.push(p.user)
      if (p.user.includes("Is the goal fully achieved?"))
        return opts.goalCheck
          ? opts.goalCheck()
          : Effect.succeed(JSON.stringify({ achieved: true, missing: "", evidence: "line 0 of file 0" }))
      return Effect.succeed(opts.step ? opts.step() : atom())
    },
    executor: {
      run: (input) => {
        executed.push(input.tool)
        return Effect.succeed({ ok: true, output: "o", artifacts: new Map<string, string>() })
      },
    },
    runner: { run: () => Effect.succeed({ exitCode: opts.runnerExit ?? 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => false,
    cwd: ".",
    toolNames: opts.toolNames ?? JhBasicTools.TOOL_NAMES,
    listFiles: workspace24,
    verifyGoal: true,
    ...(opts.rootDecompose ? { forceRootDecompose: true } : {}),
    limits: {
      maxDepth: opts.maxDepth ?? 0,
      maxTotalSteps: opts.maxTotalSteps ?? 4,
      ...(opts.contextTokens === undefined ? {} : { contextTokens: opts.contextTokens }),
    },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, prompts, executed }
}
const run = (p: ReturnType<typeof probe>) => Effect.runPromise(JhEngine.runTask(p.deps, { goal: "the task" }))
const details = (r: JhEngine.Report): string[] =>
  r.state.log.filter((e) => e.type === "verification").map((e) => String((e as { detail?: unknown }).detail))

describe("no prompt the engine sends carries an unbudgeted workspace", () => {
  test("🔴 the largest user prompt of a real run stays inside the model's window", async () => {
    const p = probe({ contextTokens: 32_768 })
    await run(p)
    const largest = p.prompts.reduce((a, b) => (a.length > b.length ? a : b), "")
    const budget = JhEngine.workspaceCharBudget(32_768)
    console.log(
      `[engine] ${p.prompts.length} prompts; largest = ${largest.length} chars ≈ ${Math.round(Token.estimate(largest))} tokens (workspace budget ${budget})`,
    )
    expect(p.prompts.length).toBeGreaterThan(0)
    // The workspace budget plus generous room for everything else a prompt carries: the artifact/goal
    // base (JhContext caps itself at 24,000), the program-output tail, and the recovery/steer blocks.
    expect(largest.length).toBeLessThanOrEqual(budget + 40_000)
  })
})

// ── 2. a verifier that cannot run has not verified ─────────────────────────────────────────────────
describe("a goal-check whose model call FAILED never reports the goal achieved", () => {
  const dead = () => Effect.fail({ message: "connection reset" })

  // The ROOT whole-task check is the one that matters most: on the default Strict path no rig supplies
  // `completionGate` and `strict.ts` supplies no `taskComplete`, so this verdict IS the completion
  // authority. Reaching it needs a child that commits on a STRONG check (a weak check would fire the
  // per-step goal check first and block there), so the root's is the only goal-check in the run.
  const rootPath = (goalCheck: () => Effect.Effect<string, JhEngine.LLMFail>) => {
    const steps = [
      atom({ goal: "whole task" }), // atomic root → soft-decompose
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
      atom({ goal: "run it", tool: "run", args: { command: "x" }, check: { type: "run", command: "x" } }),
    ]
    let i = 0
    const p = probe({
      contextTokens: 32_768,
      goalCheck,
      rootDecompose: true,
      maxDepth: 2,
      maxTotalSteps: 6,
      step: () => steps[i++] ?? atom(),
    })
    return p
  }

  test("🔴 the ROOT whole-task verdict — the Strict completion authority — refuses, and says why", async () => {
    const p = rootPath(dead)
    const report = await run(p)
    console.log(`[goalcheck] root status=${report.status} verdicts=${JSON.stringify(details(report))}`)
    expect(report.status).not.toBe("done")
    expect(details(report).some((d) => d.includes("NOT achieved") && d.includes("goal-check could not run"))).toBe(true)
    expect(details(report).some((d) => d.includes("task goal achieved"))).toBe(false)
  })

  test("the control: the SAME root path with a live checker reports the task done", async () => {
    const report = await run(
      rootPath(() => Effect.succeed(JSON.stringify({ achieved: true, missing: "", evidence: "line 0 of file 0" }))),
    )
    console.log(`[goalcheck] root control status=${report.status}`)
    expect(report.status).toBe("done")
  })

  test("🔴 the WEAK-LEAF check does not commit on a dead checker either", async () => {
    const p = probe({ contextTokens: 32_768, goalCheck: dead })
    const report = await run(p)
    console.log(`[goalcheck] leaf status=${report.status} verdicts=${JSON.stringify(details(report))}`)
    expect(report.status).not.toBe("done")
    expect(details(report).some((d) => d.includes("goal-check could not run"))).toBe(true)
  })

  test("the control: a goal-check that DOES answer still completes the task", async () => {
    const report = await run(probe({ contextTokens: 32_768 }))
    console.log(`[goalcheck] control status=${report.status}`)
    expect(report.status).toBe("done")
  })
})

// ── 3. the tool vocabulary is a constraint ─────────────────────────────────────────────────────────
const WITHOUT_REVERT = JhBasicTools.TOOL_NAMES.filter((t) => t !== "git_revert")

describe("a tool the caller withdrew is neither advertised nor executed", () => {
  test("🔴 the engine never asks the executor for a tool outside the vocabulary", async () => {
    // The model names the withdrawn tool anyway (it is in its training, and the engine itself used to
    // name it in the recovery directive). Nothing may reach `git checkout -- .` in the user's project.
    let n = 0
    const p = probe({
      contextTokens: 32_768,
      toolNames: WITHOUT_REVERT,
      step: () => (n++ === 0 ? atom({ tool: "git_revert", args: { path: "." } }) : atom()),
    })
    await run(p)
    console.log(`[vocabulary] executor saw ${JSON.stringify(p.executed)}`)
    expect(p.executed).not.toContain("git_revert")
    expect(p.executed.length).toBeGreaterThan(0) // the run really did execute something
  })

  test("🔴 the recovery directive does not name a withdrawn tool (with the control that it names an available one)", async () => {
    // A leaf whose `run` check fails drives the recovery directive on every retry.
    const failing = () => atom({ check: { type: "run", command: "boom" } })
    const withIt = probe({ contextTokens: 32_768, toolNames: JhBasicTools.TOOL_NAMES, step: failing, runnerExit: 1 })
    await run(withIt)
    const without = probe({ contextTokens: 32_768, toolNames: WITHOUT_REVERT, step: failing, runnerExit: 1 })
    await run(without)
    const named = (ps: string[]) => ps.filter((s) => s.includes("git_revert") || s.includes("git-revert")).length
    console.log(`[vocabulary] git_revert named in ${named(withIt.prompts)} prompts with it, ${named(without.prompts)} without`)
    // The control: with the tool available the directive DOES name it, so the assertion below gates the
    // GATE rather than a directive that never fired.
    expect(named(withIt.prompts)).toBeGreaterThan(0)
    expect(named(without.prompts)).toBe(0)
  })
})
