import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhArtifact } from "./artifact"
import { JhBudget } from "./budget"
import { JhBasicTools } from "./tools-basic"
import { JhEngine } from "./engine"

// improve3 P1 — harness-owned auto-revert. A leaf whose action is edit_file and whose check is a `compile`
// that FAILS is a build-DAMAGING edit; AUTO_REVERT_AFTER=3 consecutive ones → the harness restores the
// checkpoint. Distinct compile-error outputs per attempt keep the leaf out of the "stuck" path so the flow
// reaches the recovery re-introspect (where the restore message is delivered).

const editAtom = () => JSON.stringify({ goal: "fix a function", size: "atomic", tool: "edit_file", args: { path: "f.c", old_string: "a", new_string: "b" }, success: "compiles", check: { type: "compile", command: "gcc f.c" }, produces: [{ id: "f", type: "file" }] })
const runAtom = () => JSON.stringify({ goal: "fix a function", size: "atomic", tool: "run", args: { command: "./x" }, success: "right output", check: { type: "run", command: "./x", expect: "OK" }, produces: [] })

function harness(opts: {
  replies: string[]
  runResults: Array<{ exitCode: number; output: string }>
  revert?: () => { ok: boolean; detail: string }
  autoRevert?: boolean
  withDep?: boolean
}) {
  const replies = [...opts.replies]
  const runResults = [...opts.runResults]
  let revertCalls = 0
  const prompts: string[] = []
  const hasDep = opts.withDep !== false
  const deps: JhEngine.Deps = {
    introspect: (p) => {
      prompts.push(p.user)
      const r = replies.shift()
      return r === undefined ? Effect.fail({ message: "no more replies" }) : Effect.succeed(r)
    },
    correct: () => Effect.fail({ message: "x" }),
    executor: { run: () => Effect.succeed({ ok: true, output: "edited", artifacts: new Map([["f", "content"]]) }) },
    runner: { run: () => Effect.succeed({ ...(runResults.shift() ?? { exitCode: 0, output: "" }), timedOut: false }) },
    artifacts: JhArtifact.memory(),
    fileExists: () => true,
    cwd: ".",
    toolNames: JhBasicTools.TOOL_NAMES,
    revertWorkspace: hasDep
      ? () =>
          Effect.sync(() => {
            revertCalls++
            return opts.revert ? opts.revert() : { ok: true, detail: "restored" }
          })
      : undefined,
    autoRevert: opts.autoRevert,
    limits: { maxDepth: 4, maxTotalSteps: 32 },
    trigger: JhBudget.DEFAULT_TRIGGER,
  }
  return { deps, revertCalls: () => revertCalls, prompts }
}
const run = (h: ReturnType<typeof harness>) => Effect.runPromise(JhEngine.runTask(h.deps, { goal: "the task" }))
const reverts = (r: JhEngine.Report) => r.state.log.filter((e) => e.type === "reverted")

describe("improve3 P1 auto-revert", () => {
  test("3 consecutive build-damaging edits → auto-revert ONCE + `reverted` log + restore message next prompt", async () => {
    const h = harness({
      replies: [editAtom(), editAtom(), editAtom(), editAtom()], // 3 that break the build + a 4th that compiles
      runResults: [
        { exitCode: 1, output: "error A" },
        { exitCode: 1, output: "error B" },
        { exitCode: 1, output: "error C" }, // buildDamage hits 3 here → revert
        { exitCode: 0, output: "" }, // the post-revert edit compiles → commit
      ],
      autoRevert: true,
    })
    const r = await run(h)
    expect(h.revertCalls()).toBe(1)
    expect(reverts(r).length).toBe(1)
    expect(h.prompts.some((p) => p.includes("harness has RESTORED"))).toBe(true)
    expect(r.status).toBe("done")
  })

  test("autoRevert:false → never reverts even after many build-damaging edits", async () => {
    const h = harness({
      replies: Array.from({ length: 6 }, () => editAtom()),
      runResults: Array.from({ length: 6 }, (_, i) => ({ exitCode: 1, output: `error ${i}` })),
      autoRevert: false,
    })
    await run(h)
    expect(h.revertCalls()).toBe(0)
  })

  test("no revertWorkspace dep → auto-revert inert (never called)", async () => {
    const h = harness({
      replies: Array.from({ length: 6 }, () => editAtom()),
      runResults: Array.from({ length: 6 }, (_, i) => ({ exitCode: 1, output: `error ${i}` })),
      autoRevert: true,
      withDep: false,
    })
    const r = await run(h)
    expect(h.revertCalls()).toBe(0)
    expect(reverts(r).length).toBe(0)
  })

  test("a failing revert disables auto-revert (no second revert call)", async () => {
    // 6 distinct build-damaging edits: buildDamage would hit 3 twice (at edit 3 and edit 6); the first revert
    // returns ok:false → autoRevert disables → the second never fires.
    const h = harness({
      replies: Array.from({ length: 6 }, () => editAtom()),
      runResults: Array.from({ length: 6 }, (_, i) => ({ exitCode: 1, output: `error ${i}` })),
      revert: () => ({ ok: false, detail: "not a git repo" }),
      autoRevert: true,
    })
    const r = await run(h)
    expect(h.revertCalls()).toBe(1) // called once, failed, then disabled
    expect(reverts(r).some((e) => String((e as { reason?: unknown }).reason).includes("revert unavailable"))).toBe(true)
  })

  test("non-compile failures (wrong output on a compiling build) do NOT count toward build-damage", async () => {
    // run-check failures are not build damage; buildDamage stays 0, so no revert regardless of count.
    const h = harness({
      replies: Array.from({ length: 6 }, () => runAtom()),
      runResults: Array.from({ length: 6 }, () => ({ exitCode: 0, output: "WRONG" })), // runs fine, wrong output
      autoRevert: true,
    })
    await run(h)
    expect(h.revertCalls()).toBe(0)
  })
})
