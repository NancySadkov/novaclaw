import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Quality } from "./quality"
import { SessionStrict } from "./strict"

// v0.2.0 — the SESSION half of the completion gate (todo/v0.2.0-prep.md item 12).
//
// The filing said `JhEngine.Deps.taskComplete` is unreachable from the session route, leaving Strict's
// completion SELF-ATTESTED: with no oracle, `verifyGoal`'s LLM goal-check was the sole authority on
// "the whole task is done" — the model grading its own homework, which jh.md §14.1 explicitly forbids
// ("treat judge calls and self-assessments as fallible input, NEVER as ground truth"). An exact oracle
// cannot be supplied here (it needs the expected answer, which only a benchmark rig has), so the
// production verifier is the one the product already ships: the instance's provisioned QUALITY
// commands — the same block the ordinary drain loop runs as steers, which Strict alone ignored.
//
// These tests pin the two halves separately: WHICH commands become the gate (pure), and that the gate
// is actually REACHED from `SessionStrict.runTask` (the thing the filing said was impossible).

const cfg = (over: Partial<Quality.Config> = {}): Quality.Config => ({
  enabled: true,
  cadence: 2,
  testTimeout: 300_000,
  commands: {},
  ...over,
})

describe("SessionStrict.completionChecks", () => {
  test("no config, or quality OFF, is NO gate — an instance without a verifier gets no fake one", () => {
    expect(SessionStrict.completionChecks(undefined)).toEqual([])
    expect(SessionStrict.completionChecks(cfg({ enabled: false, commands: { test: "bun test" } }))).toEqual([])
  })

  test("only WHOLE-PROJECT commands gate: the per-file templates are excluded", () => {
    // `syntax`/`check` are `{file}` templates (Quality.renderCommand) — they answer a question about
    // one edit, not about the deliverable, and running them with no file substituted would be a
    // fabricated verdict.
    expect(SessionStrict.completionChecks(cfg({ commands: { syntax: "tsc {file}", check: "eslint {file}" } }))).toEqual(
      [],
    )
  })

  test("typecheck → test → lint, each with its own timeout", () => {
    const checks = SessionStrict.completionChecks(
      cfg({ testTimeout: 42_000, commands: { lint: "L", test: "T", typecheck: "TC", syntax: "S" } }),
    )
    expect(checks.map((c) => c.label)).toEqual(["typecheck", "test", "lint"])
    expect(checks.map((c) => c.command)).toEqual(["TC", "T", "L"])
    expect(checks.map((c) => c.timeoutMs)).toEqual([
      SessionStrict.COMPLETION_TYPECHECK_TIMEOUT,
      42_000, // the configured test timeout, not a hardcoded one
      SessionStrict.COMPLETION_LINT_TIMEOUT,
    ])
  })

  test("a partial provision gates on what exists", () => {
    expect(SessionStrict.completionChecks(cfg({ commands: { test: "T" } })).map((c) => c.label)).toEqual(["test"])
  })
})

describe("SessionStrict.completionGateFor", () => {
  const fakeRunner = (results: Record<string, { exitCode?: number; timedOut?: boolean; output?: string }>) => {
    const ran: string[] = []
    return {
      ran,
      runner: {
        run: (input: { command: string; cwd: string; timeoutMs: number }) => {
          ran.push(input.command)
          const r = results[input.command] ?? { exitCode: 0 }
          return Effect.succeed({ exitCode: r.exitCode, output: r.output ?? "", timedOut: r.timedOut ?? false })
        },
      },
    }
  }
  const checks = SessionStrict.completionChecks(cfg({ commands: { typecheck: "TC", test: "T", lint: "L" } }))

  test("all green ⇒ verified, and every check actually ran", async () => {
    const f = fakeRunner({})
    const verdict = await Effect.runPromise(SessionStrict.completionGateFor(f.runner, checks, "/w")())
    expect(verdict.ok).toBe(true)
    expect(f.ran).toEqual(["TC", "T", "L"])
  })

  test("the FIRST failure short-circuits — the gate never runs a whole battery to say no", async () => {
    const f = fakeRunner({ TC: { exitCode: 1, output: "type error in a.ts" } })
    const verdict = await Effect.runPromise(SessionStrict.completionGateFor(f.runner, checks, "/w")())
    expect(verdict.ok).toBe(false)
    expect(f.ran).toEqual(["TC"]) // `T` (a full test suite) was never paid for
    expect(verdict.detail).toContain("typecheck check failed with exit 1")
    expect(verdict.detail).toContain("type error in a.ts")
  })

  test("a TIMEOUT reads as not-verified and says so — never as a pass", async () => {
    const f = fakeRunner({ TC: { exitCode: 0 }, T: { timedOut: true, exitCode: undefined, output: "hung" } })
    const verdict = await Effect.runPromise(SessionStrict.completionGateFor(f.runner, checks, "/w")())
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain("timed out")
  })

  test("a REFUSED command (the host-exec gate denying it: exitCode undefined) is not-verified", async () => {
    const f = fakeRunner({ TC: { exitCode: undefined, output: "denied: unattended commands need a sandbox" } })
    const verdict = await Effect.runPromise(SessionStrict.completionGateFor(f.runner, checks, "/w")())
    expect(verdict.ok).toBe(false)
    expect(verdict.detail).toContain("denied")
  })
})

// The reachability test the filing is actually about: drive the PRODUCTION entry point and observe the
// gate fire. Everything here is the real path — real deps assembly, real planned runner, real spawn.
describe("SessionStrict.runTask reaches the gate (the filing's claim, inverted)", () => {
  const scriptedRun = (quality: Quality.Config | undefined, cwd: string) => {
    // The root replies atomic (forcing the soft-decompose), the single phase carries a STRONG run
    // check so it commits without a per-step goal-check, and the whole-task goal-check then claims
    // success with a quote that IS in the workspace (so the evidence rule passes and the ONLY thing
    // left standing between the claim and `done` is the mechanical gate).
    const leaf = {
      size: "atomic",
      tool: "run",
      args: { command: "exit 0" },
      success: "ok",
      check: { type: "run", command: "exit 0" },
      produces: [],
    }
    const steps = [
      JSON.stringify({ goal: "whole task", ...leaf }),
      JSON.stringify({
        goal: "root",
        size: "needs_decomposition",
        success: "ok",
        substeps: [{ goal: "do it", ...leaf }],
      }),
      JSON.stringify({ goal: "do it", ...leaf }),
    ]
    let i = 0
    return SessionStrict.runTask({
      task: "do the thing",
      cwd,
      strict: { wallMinutes: 2 },
      ...(quality === undefined ? {} : { quality }),
      completeOnce: (_system, user) =>
        Effect.succeed(
          user.includes("Is the goal fully achieved?")
            ? `{"achieved": true, "missing": "", "evidence": "PROOF-42"}`
            : (steps[i++] ?? JSON.stringify({ goal: "again", ...leaf })),
        ),
      onMilestone: () => Effect.void,
    }).pipe(Effect.runPromise)
  }
  // ⚠️ `bun test` does NOT run `process.on("exit")` handlers (AGENTS.md pitfall #8), so the sweep is an
  // afterAll, not an exit hook — otherwise every run of this file leaves a fixture root in %TEMP%.
  const roots: string[] = []
  afterAll(() => {
    for (const r of roots)
      try {
        fs.rmSync(r, { recursive: true, force: true })
      } catch {}
  })
  const workspace = () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "jh-gate-"))
    roots.push(cwd)
    fs.writeFileSync(path.join(cwd, "out.txt"), "RESULT PROOF-42 done")
    return cwd
  }

  test("a FAILING project verification command blocks the done the goal-check asked for", async () => {
    const report = await scriptedRun(cfg({ commands: { test: "exit 3" }, testTimeout: 20_000 }), workspace())
    const gate = report.state.log.filter((e) => e.type === "completion_gate")
    expect(gate.length).toBeGreaterThan(0) // ← the whole point: production Strict now reaches a verifier
    expect(gate.every((e) => !(e as { ok: boolean }).ok)).toBe(true)
    expect(report.status).toBe("blocked")
    expect(report.reason).toBe("completion_unverified")
    expect(report.state.log.some((e) => e.type === "task_done")).toBe(false)
  }, 60_000)

  test("NEGATIVE CONTROL — the same run with a PASSING command reports done", async () => {
    const report = await scriptedRun(cfg({ commands: { test: "exit 0" }, testTimeout: 20_000 }), workspace())
    expect(report.state.log.some((e) => e.type === "completion_gate" && (e as { ok: boolean }).ok)).toBe(true)
    expect(report.status).toBe("done")
  }, 60_000)

  test("NEGATIVE CONTROL — with NO quality config there is no gate at all (today's behaviour)", async () => {
    const report = await scriptedRun(undefined, workspace())
    expect(report.state.log.filter((e) => e.type === "completion_gate")).toEqual([])
    expect(report.status).toBe("done")
  }, 60_000)

  test("the refusal is surfaced to the USER as a milestone, not buried in the engine log", async () => {
    // A guard the user cannot see is a guard they will not trust when it stops their run.
    const notices: string[] = []
    const cwd = workspace()
    fs.writeFileSync(path.join(cwd, "out.txt"), "RESULT PROOF-42 done")
    const leaf = {
      size: "atomic",
      tool: "run",
      args: { command: "exit 0" },
      success: "ok",
      check: { type: "run", command: "exit 0" },
      produces: [],
    }
    const steps = [
      JSON.stringify({ goal: "whole task", ...leaf }),
      JSON.stringify({
        goal: "root",
        size: "needs_decomposition",
        success: "ok",
        substeps: [{ goal: "do it", ...leaf }],
      }),
      JSON.stringify({ goal: "do it", ...leaf }),
    ]
    let i = 0
    await SessionStrict.runTask({
      task: "do the thing",
      cwd,
      strict: { wallMinutes: 2 },
      quality: cfg({ commands: { test: "exit 3" }, testTimeout: 20_000 }),
      completeOnce: (_system, user) =>
        Effect.succeed(
          user.includes("Is the goal fully achieved?")
            ? `{"achieved": true, "missing": "", "evidence": "PROOF-42"}`
            : (steps[i++] ?? JSON.stringify({ goal: "again", ...leaf })),
        ),
      onMilestone: (text) => Effect.sync(() => void notices.push(text)),
    }).pipe(Effect.runPromise)
    expect(notices.join("\n")).toContain("completion_gate")
  }, 60_000)

  test("the terminal notice explains the stop in words, and never claims completion", () => {
    const text = SessionStrict.terminalNotice({
      status: "blocked",
      reason: "completion_unverified",
      steps: 7,
      single: true,
      keptBest: false,
    })
    expect(text).toContain("did NOT pass this project's own verification commands")
    expect(text).toContain("not reported complete")
    expect(text).not.toContain("✅") // never the done wording
    expect(text).not.toContain("every one verified")
    expect(text).toContain("resume")
  })
})
