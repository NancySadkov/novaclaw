import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import { JhEngine } from "./engine"

// jh-improve5 P1 — workspace RENDERING (numbered editing view + full visibility) verified via prompt capture.
// A single-atom task: the root's introspect prompt is the EDITING view (buildContext → numbered); the
// goal-check prompt is the verification view (renderWorkspace → UNNUMBERED, so the oracle/evidence checks
// are never number-polluted). We record every prompt and assert on their content.

function capture(opts: { file: { name: string; content: string }; numberedWorkspace?: boolean; fullFiles?: boolean }) {
  const prompts: { readonly goalCheck: boolean; readonly user: string }[] = []
  const atom = JSON.stringify({ goal: "s", size: "atomic", tool: "note", args: { text: "x" }, check: { type: "artifact_present" }, produces: [], success: "ok" })
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      const goalCheck = p.user.includes("Is the goal fully achieved?")
      prompts.push({ goalCheck, user: p.user })
      return Effect.succeed(goalCheck ? '{"achieved": true, "evidence": ""}' : atom)
    },
    correct: () => Effect.fail({ message: "x" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "o", artifacts: new Map<string, string>() }) },
    runner: { run: () => Effect.succeed({ exitCode: 0, output: "", timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => true,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    listFiles: () => [opts.file],
    verifyGoal: true, // fire a per-step goal-check → captures the renderWorkspace prompt
    numberedWorkspace: opts.numberedWorkspace,
    fullFiles: opts.fullFiles,
    limits: { maxDepth: 0, maxTotalSteps: 6 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, prompts }
}
const run = (deps: JhEngine.Deps) => Effect.runPromise(JhEngine.runTask(deps, { goal: "the task" }))
const editing = (ps: { goalCheck: boolean; user: string }[]) => ps.find((p) => !p.goalCheck)!.user
const goalCheckPrompt = (ps: { goalCheck: boolean; user: string }[]) => ps.find((p) => p.goalCheck)?.user

describe("jh-improve5 P1 — numbered full-visibility workspace rendering", () => {
  test("default: the EDITING view is line-numbered (`N→`); the goal-check view is UNNUMBERED", async () => {
    const { deps, prompts } = capture({ file: { name: "a.c", content: "int a;\nint b;\nint c;" } })
    await run(deps)
    const ed = editing(prompts)
    expect(ed).toContain("1→int a;")
    expect(ed).toContain("2→int b;")
    expect(ed).toContain("N→") // the header note explains the prefix
    const gc = goalCheckPrompt(prompts)
    expect(gc).toBeDefined()
    expect(gc).toContain("int a;") // content present…
    expect(gc).not.toContain("1→int a;") // …but NOT numbered (no digit pollution of the oracle/evidence)
  })

  test("numberedWorkspace:false — the editing view is unnumbered (wave-4 parity)", async () => {
    const { deps, prompts } = capture({ file: { name: "a.c", content: "int a;\nint b;" }, numberedWorkspace: false })
    await run(deps)
    expect(editing(prompts)).not.toContain("1→int a;")
  })

  test("fullFiles ON: a file over the cap shows a NAMED elision, never a bare [truncated]", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} xxxxxxxxxxxxxxxxxxxx`).join("\n") // ~112KB, > 24000
    const { deps, prompts } = capture({ file: { name: "big.c", content: big } })
    await run(deps)
    const ed = editing(prompts)
    expect(ed).toMatch(/lines \d+-\d+ omitted/) // the elision NAMES what's hidden
    expect(ed).toContain('use read_file "big.c"')
    expect(ed).not.toContain("[truncated]")
    expect(ed).toContain("1→line 0") // head is numbered
  })

  test("fullFiles:false — wave-4 exact: 8000-char cap + unnamed [truncated]", async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `line ${i} xxxxxxxxxxxxxxxxxxxx`).join("\n")
    const { deps, prompts } = capture({ file: { name: "big.c", content: big }, numberedWorkspace: false, fullFiles: false })
    await run(deps)
    const ed = editing(prompts)
    expect(ed).toContain("[truncated]")
    expect(ed).not.toMatch(/lines \d+-\d+ omitted/)
  })

  test("the run84 fixture: a marker beyond char 8000 is INVISIBLE under wave-4 flags, VISIBLE under wave-5", async () => {
    // a file whose unique target line sits past 8000 chars but within 24000
    const filler = Array.from({ length: 500 }, (_, i) => `/* pad line ${i} ................ */`).join("\n") // ~18KB
    const content = filler + "\n/* TARGET_beyond_8000 */\nint tail;"
    expect(content.length).toBeGreaterThan(8000)
    expect(content.length).toBeLessThan(24000)
    // wave-4: fullFiles off → truncated at 8000 → the target is NOT shown (the model can't quote what it can't see)
    const w4 = capture({ file: { name: "pi.c", content }, fullFiles: false, numberedWorkspace: false })
    await run(w4.deps)
    expect(editing(w4.prompts)).not.toContain("TARGET_beyond_8000")
    // wave-5: full visibility → the target IS shown, numbered, so replace_lines can address it
    const w5 = capture({ file: { name: "pi.c", content } })
    await run(w5.deps)
    expect(editing(w5.prompts)).toContain("TARGET_beyond_8000")
  })
})

// jh-improve5 P4 — budget-aware steering. A leaf whose `run` check fails a few times re-introspects each
// round (a fresh buildContext); an injected clock crosses the thresholds so we can assert the one-shot steers.
function budgetCapture(opts: { clock: number[]; budgetAware?: boolean; withBudget?: boolean; failChecks: number }) {
  const introspectPrompts: string[] = []
  let checkCalls = 0
  let c = 0
  const atom = JSON.stringify({ goal: "s", size: "atomic", tool: "note", args: { text: "x" }, check: { type: "run", command: "go" }, produces: [], success: "ok" })
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      if (!p.user.includes("Is the goal fully achieved?")) introspectPrompts.push(p.user)
      return Effect.succeed(atom)
    },
    correct: () => Effect.fail({ message: "x" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "noted", artifacts: new Map<string, string>() }) },
    runner: {
      run: () => {
        checkCalls++
        return Effect.succeed({ exitCode: checkCalls > opts.failChecks ? 0 : 1, output: "err", timedOut: false })
      },
    },
    artifacts: JhArtifact.memory(),
    fileExists: () => true,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    limits: { maxDepth: 0, maxTotalSteps: 10 },
    trigger: JhBudget.DEFAULT_TRIGGER,
    budgetAware: opts.budgetAware,
    budget: opts.withBudget === false ? undefined : { startedAt: 0, wallMs: 100, now: () => opts.clock[Math.min(c++, opts.clock.length - 1)]! },
  }
  return { deps, introspectPrompts }
}

describe("jh-improve5 P4 — budget-aware steering", () => {
  test("crossing 50% then 75% injects each steer ONCE, in the introspect prompt", async () => {
    // buildContext fires on the root introspect + each recovery; the clock advances 40→60→80→80…
    const { deps, introspectPrompts } = budgetCapture({ clock: [40, 60, 80, 80, 80, 80], failChecks: 3 })
    const r = await Effect.runPromise(JhEngine.runTask(deps, { goal: "t" }))
    const notes = r.state.log.filter((e) => e.type === "budget_note").map((e) => (e as { fraction: number }).fraction)
    expect(notes).toEqual([0.5, 0.75]) // each threshold once, in order
    expect(introspectPrompts.some((p) => p.includes("half the time budget remains"))).toBe(true)
    expect(introspectPrompts.some((p) => p.includes("quarter of the time budget remains"))).toBe(true)
  })

  test("no budget dep → no steers", async () => {
    const { deps } = budgetCapture({ clock: [90], withBudget: false, failChecks: 2 })
    const r = await Effect.runPromise(JhEngine.runTask(deps, { goal: "t" }))
    expect(r.state.log.some((e) => e.type === "budget_note")).toBe(false)
  })

  test("budgetAware:false → no steers even with the dep present", async () => {
    const { deps } = budgetCapture({ clock: [60, 80], budgetAware: false, failChecks: 2 })
    const r = await Effect.runPromise(JhEngine.runTask(deps, { goal: "t" }))
    expect(r.state.log.some((e) => e.type === "budget_note")).toBe(false)
  })
})
