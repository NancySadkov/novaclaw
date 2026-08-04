import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { HostExec } from "../host-exec"
import { JhProcessRunner } from "./process-runner"

const run = (r: JhProcessRunner.Runner, input: { command: string; cwd: string; timeoutMs: number }) =>
  Effect.runPromise(r.run(input))
const cwd = process.cwd()

describe("JhProcessRunner.shellRunner", () => {
  test("echo → exit 0 with merged output", async () => {
    const res = await run(JhProcessRunner.shellRunner(), { command: "echo hi", cwd, timeoutMs: 10_000 })
    expect(res.exitCode).toBe(0)
    expect(res.output).toContain("hi")
    expect(res.timedOut).toBe(false)
  })

  test("spawn failure (bad shell) resolves to a RunResult, never throws", async () => {
    const r = JhProcessRunner.shellRunner({ shell: "definitely-not-a-shell-xyz.exe" })
    const res = await run(r, { command: "echo hi", cwd, timeoutMs: 10_000 })
    expect(res.exitCode).toBeUndefined()
    expect(res.output.length).toBeGreaterThan(0)
  })

  test("timeout → timedOut true, exitCode undefined", async () => {
    const cmd = `"${process.execPath}" -e "setInterval(()=>{},1000)"`
    const res = await run(JhProcessRunner.shellRunner(), { command: cmd, cwd, timeoutMs: 500 })
    expect(res.timedOut).toBe(true)
    expect(res.exitCode).toBeUndefined()
  }, 15_000)

  test("output cap appends the truncation marker", async () => {
    const cmd = `"${process.execPath}" -e "process.stdout.write('x'.repeat(200000))"`
    const res = await run(JhProcessRunner.shellRunner({ maxOutputBytes: 65_536 }), {
      command: cmd,
      cwd,
      timeoutMs: 15_000,
    })
    expect(res.output.endsWith("…[truncated]")).toBe(true)
    expect(res.output.length).toBeLessThanOrEqual(65_536 + 20)
  }, 20_000)
})

// v0.2.0 ruling 6: the runner executes a PLAN from the one host-execution gate and decides nothing
// itself. §0.7.2 keeps `src/jh/**` off the session/tool trees, so the plan arrives as plain data.
describe("JhProcessRunner.plannedRunner", () => {
  test("a REFUSAL starts no process — the routing text is the whole observation", async () => {
    const runner = JhProcessRunner.plannedRunner({ plan: () => ({ denied: "no raw shell on this host" }) })
    const res = await run(runner, { command: "rm -rf /", cwd, timeoutMs: 10_000 })
    expect(res).toEqual({ exitCode: undefined, output: "no raw shell on this host", timedOut: false })
  })

  test("a file+argv plan execs directly — the command string is not consulted at all", async () => {
    const runner = JhProcessRunner.plannedRunner({
      plan: () => ({
        file: process.execPath,
        args: ["-e", "process.stdout.write('exec-path-taken')"],
        env: HostExec.curatedEnv(),
        inherit: false,
      }),
    })
    const res = await run(runner, { command: "this string must be ignored", cwd, timeoutMs: 20_000 })
    expect(res.exitCode).toBe(0)
    expect(res.output).toContain("exec-path-taken")
  }, 25_000)

  test("inherit:false REPLACES the environment — a serve-process secret never reaches the child", async () => {
    process.env.NOVACLAW_HOSTEXEC_TEST_SECRET = "s3cr3t"
    try {
      const runner = JhProcessRunner.plannedRunner({
        plan: () => ({
          file: process.execPath,
          args: [
            "-e",
            "process.stdout.write(String(process.env.NOVACLAW_HOSTEXEC_TEST_SECRET)+'|'+String(process.env.NOVACLAW_HOSTEXEC_MARK))",
          ],
          // exactly what the gate composes for an uncredentialed child, plus a marker
          env: { ...HostExec.curatedEnv(), NOVACLAW_HOSTEXEC_MARK: "present" },
          inherit: false,
        }),
      })
      const res = await run(runner, { command: "(ignored)", cwd, timeoutMs: 20_000 })
      expect(res.output).toContain("undefined|present")
    } finally {
      delete process.env.NOVACLAW_HOSTEXEC_TEST_SECRET
    }
  }, 25_000)

  test("inherit:true merges over the parent environment", async () => {
    process.env.NOVACLAW_HOSTEXEC_TEST_INHERITED = "from-parent"
    try {
      const runner = JhProcessRunner.plannedRunner({
        plan: () => ({
          file: process.execPath,
          args: [
            "-e",
            "process.stdout.write(String(process.env.NOVACLAW_HOSTEXEC_TEST_INHERITED)+'|'+String(process.env.NOVACLAW_HOSTEXEC_MARK))",
          ],
          env: { NOVACLAW_HOSTEXEC_MARK: "present" },
          inherit: true,
        }),
      })
      const res = await run(runner, { command: "(ignored)", cwd, timeoutMs: 20_000 })
      expect(res.output).toContain("from-parent|present")
    } finally {
      delete process.env.NOVACLAW_HOSTEXEC_TEST_INHERITED
    }
  }, 25_000)

  test("the gate's own plan runs: an undeclared, uncredentialed shell command still executes", async () => {
    const runner = JhProcessRunner.plannedRunner({
      plan: (input) =>
        HostExec.spawnPlan({
          shape: { kind: "shell-command", shell: HostExec.resolveShell(), command: input.command },
          cwd: input.cwd,
          worktree: input.cwd,
          consent: "none",
        }),
    })
    const res = await run(runner, { command: "echo gated", cwd, timeoutMs: 20_000 })
    expect(res.exitCode).toBe(0)
    expect(res.output).toContain("gated")
  }, 25_000)
})
