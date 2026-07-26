import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionStrict } from "./strict"
import { SessionInput } from "../input"
import type { SessionMessage } from "../message"
import type { JhEngine } from "../../jh/engine"
import type { JhLog } from "../../jh/log"
import { JhTree } from "../../jh/tree"

// P14-minimal (jh-improve8 P3) — the session-independent half of the Strict route. The engine
// integration itself is gated by the LIVE smoke (tests/jh-strict-session-smoke.ts, plan P4).

describe("SessionStrict.flagsFor", () => {
  test("all groups default → every flag undefined (engine defaults ON)", () => {
    const flags = SessionStrict.flagsFor({})
    expect(Object.values(flags).every((v) => v === undefined)).toBe(true)
  })
  test("a group set to false disables exactly its family", () => {
    const flags = SessionStrict.flagsFor({ editingAids: false, recovery: true })
    expect(flags.numberedWorkspace).toBe(false)
    expect(flags.fullFiles).toBe(false)
    expect(flags.txEdits).toBe(false)
    expect(flags.coordMode).toBe(false)
    expect(flags.keepBest).toBeUndefined() // true = engine default, not an explicit true
    expect(flags.staleness).toBeUndefined()
    expect(flags.budgetAware).toBeUndefined()
  })
})

describe("SessionStrict.milestone", () => {
  const seq = (entry: JhLog.Entry): JhLog.Sequenced => ({ ...entry, seq: 1 }) as JhLog.Sequenced
  test("phase-level structure events surface; leaf-level ones stay quiet", () => {
    expect(SessionStrict.milestone(seq({ type: "committed", step: "root.2" }))).toContain("committed root.2")
    expect(SessionStrict.milestone(seq({ type: "committed", step: "root.2.3" }))).toBeUndefined()
    expect(SessionStrict.milestone(seq({ type: "expanded", step: "root", children: 3 }))).toContain("3 children")
  })
  test("safety events always surface, at any depth", () => {
    expect(SessionStrict.milestone(seq({ type: "restored_best", step: "root.2.3.4", score: 0.8, reason: "drop" }))).toContain("restored_best")
    expect(SessionStrict.milestone(seq({ type: "coord_mode", step: "root.9.9", file: "a.c" }))).toContain("coord_mode")
    expect(SessionStrict.milestone(seq({ type: "task_blocked", reason: "wall_exhausted" }))).toContain("wall_exhausted")
  })
  test("leaf noise (action/observation/verification) never surfaces", () => {
    expect(SessionStrict.milestone(seq({ type: "action", step: "root.1", tool: "run" }))).toBeUndefined()
    expect(SessionStrict.milestone(seq({ type: "verification", step: "root", ok: false, detail: "x" }))).toBeUndefined()
  })
})

describe("SessionStrict.lastUserText", () => {
  const user = (text: string) => ({ type: "user", text }) as unknown as SessionMessage.Message
  const assistant = () => ({ type: "assistant", content: [] }) as unknown as SessionMessage.Message
  test("returns the NEWEST real user text", () => {
    expect(SessionStrict.lastUserText([user("first"), assistant(), user("second")])).toBe("second")
  })
  test("skips harness-provenance steers and blank messages", () => {
    expect(SessionStrict.lastUserText([user("real task"), user(`${SessionInput.STEER_PROVENANCE_PREFIX}nudge`), user("   ")])).toBe("real task")
    expect(SessionStrict.lastUserText([assistant()])).toBeUndefined()
  })
})

describe("SessionStrict racing helpers (improve11 P5)", () => {
  const mk = () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "jh-fork-src-"))
    fs.writeFileSync(path.join(src, "a.c"), "original A")
    fs.mkdirSync(path.join(src, "sub"))
    fs.writeFileSync(path.join(src, "sub", "b.txt"), "original B")
    fs.mkdirSync(path.join(src, ".git"))
    fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref: x")
    return src
  }
  test("forkWorkspace copies the tree (without .git); applyBack applies ONLY changed+new files", () => {
    const src = mk()
    const baseline = SessionStrict.manifestFor(src)
    const fork = SessionStrict.forkWorkspace(src, 1)
    if ("refused" in fork) throw new Error(fork.refused)
    expect(fs.readFileSync(path.join(fork.dir, "a.c"), "utf8")).toBe("original A")
    expect(fs.existsSync(path.join(fork.dir, ".git"))).toBe(false)
    // the racer edits a.c, creates c.c, leaves sub/b.txt untouched, deletes nothing back-propagatable
    fs.writeFileSync(path.join(fork.dir, "a.c"), "WINNER A")
    fs.writeFileSync(path.join(fork.dir, "c.c"), "NEW C")
    const applied = SessionStrict.applyBack(fork.dir, src, baseline)
    expect(applied.sort()).toEqual(["a.c", "c.c"])
    expect(fs.readFileSync(path.join(src, "a.c"), "utf8")).toBe("WINNER A")
    expect(fs.readFileSync(path.join(src, "c.c"), "utf8")).toBe("NEW C")
    expect(fs.readFileSync(path.join(src, "sub", "b.txt"), "utf8")).toBe("original B")
    fs.rmSync(fork.dir, { recursive: true, force: true })
  })
  test("deletions are NOT propagated (v1 safety)", () => {
    const src = mk()
    const baseline = SessionStrict.manifestFor(src)
    const fork = SessionStrict.forkWorkspace(src, 2)
    if ("refused" in fork) throw new Error(fork.refused)
    fs.rmSync(path.join(fork.dir, "sub", "b.txt"))
    const applied = SessionStrict.applyBack(fork.dir, src, baseline)
    expect(applied).toEqual([])
    expect(fs.existsSync(path.join(src, "sub", "b.txt"))).toBe(true)
    fs.rmSync(fork.dir, { recursive: true, force: true })
  })
  test("sweepStaleForks removes attempt workspaces past the retention window, keeps fresh ones", () => {
    const src = mk()
    const fork = SessionStrict.forkWorkspace(src, 2)
    if ("refused" in fork) throw new Error(fork.refused)
    // An aged workspace: back-date its mtime past the window (what a race nobody won leaves behind).
    const old = fs.mkdtempSync(path.join(os.tmpdir(), "jh-attempt9-stale-"))
    const aged = Date.now() - SessionStrict.FORK_RETENTION_MS - 60_000
    fs.utimesSync(old, aged / 1000, aged / 1000)
    expect(SessionStrict.sweepStaleForks()).toBeGreaterThan(0)
    expect(fs.existsSync(old)).toBe(false)
    expect(fs.existsSync(fork.dir)).toBe(true) // today's race is never swept
    fs.rmSync(fork.dir, { recursive: true, force: true })
  })
  test("the fork bound REFUSES with a named reason (no silent cap)", () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), "jh-fork-big-"))
    for (let i = 0; i <= SessionStrict.MAX_FORK_FILES; i++) fs.writeFileSync(path.join(src, `f${i}`), "")
    const refused = SessionStrict.forkWorkspace(src, 1)
    expect("refused" in refused && refused.refused).toContain("files")
  })
})

describe("SessionStrict.environmentFor (the shell it TELLS the model about)", () => {
  // The engine used to derive this from the platform alone and hardcode cmd.exe for Windows, while
  // the `bash` tool on the same host ran bash. One product, one shell — the text follows the shell.
  test("a bash shell is described in POSIX terms, on Windows too", () => {
    const text = SessionStrict.environmentFor("win32", "C:\\soft\\Git\\bin\\bash.exe")
    expect(text).toContain("bash")
    expect(text).toContain('PATH="$PATH:/dir/bin"')
    expect(text).not.toContain("cmd.exe")
  })
  test("APPEND, never prepend — the BusyBox-shadowing trap is named where the model reads it", () => {
    expect(SessionStrict.environmentFor("win32", "/usr/bin/bash")).toContain("PREPENDING")
  })
  test("cmd.exe is still described correctly when that IS the shell", () => {
    const text = SessionStrict.environmentFor("win32", "C:\\WINDOWS\\system32\\cmd.exe")
    expect(text).toContain("cmd.exe")
    expect(text).toContain("set PATH=")
  })
})

describe("SessionStrict.listFilesFor", () => {
  test("binary placeholders, dotfile skip, and a NAMED cap (no silent truncation)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-strictls-"))
    fs.writeFileSync(path.join(dir, "a.c"), "int main(){}")
    fs.writeFileSync(path.join(dir, "a.exe"), Buffer.from([1, 2, 3]))
    fs.writeFileSync(path.join(dir, ".gitignore"), "x")
    for (let i = 0; i < SessionStrict.FILE_LIST_CAP + 3; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i))
    const files = SessionStrict.listFilesFor(dir)
    expect(files.some((f) => f.name === ".gitignore")).toBe(false)
    expect(files.length).toBe(SessionStrict.FILE_LIST_CAP + 1) // cap + the omission note
    expect(files.at(-1)!.name).toContain("more files not shown")
    const exe = files.find((f) => f.name === "a.exe")
    // the exe may fall outside the mtime-sorted cap window on a fast filesystem — when shown, it must
    // be a placeholder, never raw bytes
    if (exe) expect(exe.content).toContain("<compiled binary")
  })
})

// P14.1 routing: with Strict enabled, EVERY message would otherwise launch a full engine run —
// including "thanks". The router keeps Strict livable; these pin its bias (only an explicit,
// FINAL "CHAT" leaves the engine path — ambiguity resolves to the user's stated stance).
describe("SessionStrict.routeOf (P14.1 routing)", () => {
  test("explicit verdicts route where they say", () => {
    expect(SessionStrict.routeOf("CHAT")).toBe("chat")
    expect(SessionStrict.routeOf("TASK")).toBe("task")
    expect(SessionStrict.routeOf("The verdict is: chat.")).toBe("chat")
  })
  test("garbage and ambiguity resolve to task (the user turned Strict on)", () => {
    expect(SessionStrict.routeOf("")).toBe("task")
    expect(SessionStrict.routeOf("I am not sure what this is")).toBe("task")
    expect(SessionStrict.routeOf("chatty tasking")).toBe("task") // no whole-word match either way
  })
  test("the LAST token wins — a reasoning model weighs both words before concluding", () => {
    expect(SessionStrict.routeOf("This could be a TASK... no, it's small talk. CHAT")).toBe("chat")
    expect(SessionStrict.routeOf("Sounds like CHAT at first, but they want a file: TASK")).toBe("task")
  })
})

// P14.1 resume: the documented continuation phrase. A message carrying NEW content must never
// match — its modifier would be silently swallowed by the resumed plan.
describe("SessionStrict.resumeIntent (P14.1 resume)", () => {
  test("bare continuation requests match", () => {
    for (const t of [
      "resume",
      "Resume.",
      "continue",
      "CONTINUE!",
      "resume the task",
      "continue where you left off",
      "resume it please",
      "continue the run",
    ])
      expect(SessionStrict.resumeIntent(t)).toBe(true)
  })
  test("messages carrying new content or unrelated text never match", () => {
    for (const t of [
      "continue, but make the button red",
      "resume tomorrow at 5",
      "continue the analysis of chapter two",
      "hi",
      "fix the bug in main.c",
      "please resume", // must START with the verb — 'please resume the big red task' shapes are unbounded
      "",
      "   ",
    ])
      expect(SessionStrict.resumeIntent(t)).toBe(false)
  })
})

// P14.1 final answer: the summary prompt is assembled from harness GROUND TRUTH only, so the
// model can't be led to claim more than the run verified.
describe("SessionStrict.summaryPrompt (P14.1 final answer)", () => {
  test("done runs state completion; goal and journal are embedded verbatim", () => {
    const p = SessionStrict.summaryPrompt({
      goal: "build the widget",
      status: "done",
      milestones: ["committed root.1 — wrote widget.c"],
      appliedFiles: [],
    })
    expect(p.user).toContain("build the widget")
    expect(p.user).toContain("completed — every step verified")
    expect(p.user).toContain("committed root.1")
    expect(p.system).toContain("ONLY on the journal")
  })
  test("stopped runs carry the reason and the kept-best framing", () => {
    const p = SessionStrict.summaryPrompt({ goal: "g", status: "blocked", reason: "aborted", milestones: [] })
    expect(p.user).toContain("stopped early (aborted)")
    expect(p.user).toContain("best verified state was kept")
    expect(p.user).toContain("(no phase milestones recorded)")
  })
  test("the journal is capped in lines and line length; applied files are named", () => {
    const many = Array.from({ length: 100 }, (_, i) => `line-${i} ` + "x".repeat(300))
    const p = SessionStrict.summaryPrompt({ goal: "g", status: "done", milestones: many, appliedFiles: ["a.c", "b.c"] })
    expect(p.user).not.toContain("line-59 ") // only the last 40 lines survive
    expect(p.user).toContain("line-99")
    expect(p.user).toContain("…") // long lines truncated
    expect(p.user).toContain("Files applied to the folder: a.c, b.c")
  })
})

// P14.1 resume threading: a resume state's tree is CONTINUED (same root goal, no fresh
// task_started), never re-planned from the new message text.
describe("SessionStrict.runTask resume (P14.1)", () => {
  test("the resumed tree is continued, not re-planned from the user's resume message", async () => {
    const tree = JhTree.create({ goal: "THE-RESUMED-GOAL", size: "atomic", success: "the task is complete" })
    const state = { tree, artifacts: [], log: [], telemetry: new Map() } as JhEngine.State
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jh-resume-"))
    const report = await SessionStrict.runTask({
      task: "resume", // the user's continuation word — must NOT become the goal
      cwd,
      strict: {},
      completeOnce: () => Effect.succeed("not json"),
      onMilestone: () => Effect.void,
      resume: state,
    }).pipe(Effect.runPromise)
    const root = report.state.tree.nodes.get(report.state.tree.root)!
    expect(root.draft.goal).toBe("THE-RESUMED-GOAL")
    expect(report.state.log.some((e) => e.type === "task_started")).toBe(false)
  })
})

// The two per-call token budgets (owner, 2026-07-16): "the settings for Strict mode should allow the
// user to configure budgets for reasoning and execution steps". These pin the CONTRACT — that each
// kind of call is charged its own budget, and that the reasoning stage is opt-in — because the
// failure they guard against is invisible: a reasoning call cut off mid-thought returns EMPTY (its
// <think> block never closes), which reads as "the model said nothing" rather than "you starved it".
describe("SessionStrict token budgets", () => {
  const calls: Array<{ maxTokens: number; system: string }> = []
  const run = (strict: Parameters<typeof SessionStrict.runTask>[0]["strict"]) => {
    calls.length = 0
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jh-budget-"))
    return SessionStrict.runTask({
      task: "do the thing",
      cwd,
      strict,
      completeOnce: (system, _user, maxTokens) => {
        calls.push({ maxTokens, system })
        // Unparseable on purpose: the run ends fast and we only assert what was BILLED per call.
        return Effect.succeed("not json")
      },
      onMilestone: () => Effect.void,
    }).pipe(Effect.runPromise)
  }

  test("execution steps are billed the configured budget", async () => {
    await run({ executionTokens: 8000 })
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((c) => c.maxTokens === 8000)).toBe(true)
  })

  test("unset = the documented default, never an accidental small number", async () => {
    await run({})
    expect(calls.every((c) => c.maxTokens === SessionStrict.EXECUTION_TOKENS_DEFAULT)).toBe(true)
    expect(SessionStrict.EXECUTION_TOKENS_DEFAULT).toBe(24_576)
  })

  test("reasoning is OFF unless budgeted — 0/undefined/negative buy no think calls", async () => {
    for (const strict of [{}, { reasoningTokens: 0 }, { reasoningTokens: -5 }]) {
      await run(strict)
      expect(calls.some((c) => c.system.includes("no JSON"))).toBe(false)
    }
  })

  test("a non-zero reasoning budget turns the stage on and is billed SEPARATELY from execution", async () => {
    await run({ reasoningTokens: 20_000, executionTokens: 8000 })
    const think = calls.filter((c) => c.system.includes("no JSON"))
    const exec = calls.filter((c) => !c.system.includes("no JSON"))
    expect(think.length).toBeGreaterThan(0)
    expect(think.every((c) => c.maxTokens === 20_000)).toBe(true)
    expect(exec.every((c) => c.maxTokens === 8000)).toBe(true)
  })
})

describe("SessionStrict.materializingExecutor (P14.1 materialization)", () => {
  const fake = (ok: boolean, output: string) => ({
    run: (_input: { tool: string; args: Readonly<Record<string, unknown>>; produces: never[]; cwd: string }) =>
      Effect.succeed({ ok, output, artifacts: new Map<string, string>() }),
  })
  const call = (tool: string, args: Record<string, unknown>, executor: ReturnType<typeof fake>, sink: unknown[]) =>
    Effect.runPromise(
      SessionStrict.materializingExecutor(executor as never, (action) =>
        Effect.sync(() => void sink.push(action)),
      ).run({ tool, args, produces: [], cwd: "." }),
    )

  test("state-changing tools + run are reported; reads and notes are not", async () => {
    const seen: Array<{ tool: string }> = []
    for (const tool of ["run", "write_file", "append_file", "edit_file", "replace_lines", "read_file", "note"])
      await call(tool, { path: "x" }, fake(true, "ok"), seen)
    expect(seen.map((a) => a.tool)).toEqual(["run", "write_file", "append_file", "edit_file", "replace_lines"])
  })

  test("the observation passes through untouched and ok/failure is reflected", async () => {
    const seen: Array<{ ok: boolean; output: string }> = []
    const good = await call("run", { command: "make" }, fake(true, "built"), seen)
    const bad = await call("run", { command: "make" }, fake(false, "boom"), seen)
    expect(good.ok).toBe(true)
    expect(bad.ok).toBe(false)
    expect(seen.map((a) => a.ok)).toEqual([true, false])
    expect(seen.map((a) => a.output)).toEqual(["built", "boom"])
  })

  test("string args and output are truncated at capture (a whole file must not flood the chat)", async () => {
    const seen: Array<{ args: Record<string, unknown>; output: string }> = []
    const bigContent = "x".repeat(SessionStrict.ACTION_ARG_CAP + 500)
    const bigOutput = "y".repeat(SessionStrict.ACTION_OUTPUT_CAP + 500)
    await call("write_file", { path: "big.c", content: bigContent, lines: 42 }, fake(true, bigOutput), seen)
    const action = seen[0]!
    expect(String(action.args.content).length).toBeLessThan(SessionStrict.ACTION_ARG_CAP + 100)
    expect(String(action.args.content)).toContain("more chars")
    expect(action.args.path).toBe("big.c") // short strings untouched
    expect(action.args.lines).toBe(42) // non-strings untouched
    expect(action.output.length).toBeLessThan(SessionStrict.ACTION_OUTPUT_CAP + 100)
  })

  test("a throwing reporter never breaks the engine action", async () => {
    const result = await Effect.runPromise(
      SessionStrict.materializingExecutor(fake(true, "fine") as never, () =>
        Effect.fail(new Error("reporter died")) as never,
      ).run({ tool: "run", args: {}, produces: [], cwd: "." }),
    )
    expect(result.ok).toBe(true)
  })
})

describe("SessionStrict.reviveForResume (P14.1 resume fix)", () => {
  const node = (id: string, status: "pending" | "expanded" | "committed" | "blocked") =>
    [id, { id, parent: undefined, draft: {}, children: [], status, depth: 0 }] as const

  test("blocked nodes return to pending (a stop mid-step must not brick the resume)", () => {
    const state = {
      tree: { root: "root", nodes: new Map([node("root", "blocked")]) },
      artifacts: [],
      log: [],
      telemetry: new Map(),
    } as never
    const revived = SessionStrict.reviveForResume(state) as never as { tree: { nodes: Map<string, { status: string }> } }
    expect(revived.tree.nodes.get("root")!.status).toBe("pending")
  })

  test("committed and expanded work is never touched; untouched states return the SAME object", () => {
    const nodes = new Map([node("root", "expanded"), node("root.1", "committed"), node("root.2", "pending")])
    const state = { tree: { root: "root", nodes }, artifacts: [], log: [], telemetry: new Map() } as never
    const revived = SessionStrict.reviveForResume(state)
    expect(revived).toBe(state) // no blocked nodes → identity (no copy churn)
    const mixed = {
      tree: { root: "root", nodes: new Map([node("root", "expanded"), node("root.1", "committed"), node("root.2", "blocked")]) },
      artifacts: [],
      log: [],
      telemetry: new Map(),
    } as never
    const out = SessionStrict.reviveForResume(mixed) as never as { tree: { nodes: Map<string, { status: string }> } }
    expect(out.tree.nodes.get("root")!.status).toBe("expanded")
    expect(out.tree.nodes.get("root.1")!.status).toBe("committed")
    expect(out.tree.nodes.get("root.2")!.status).toBe("pending")
  })
})
