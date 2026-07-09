import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { JhProcessRunner } from "./process-runner"

const run = (r: JhProcessRunner.Runner, input: { command: string; cwd: string; timeoutMs: number }) => Effect.runPromise(r.run(input))
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
    const res = await run(JhProcessRunner.shellRunner({ maxOutputBytes: 65_536 }), { command: cmd, cwd, timeoutMs: 15_000 })
    expect(res.output.endsWith("…[truncated]")).toBe(true)
    expect(res.output.length).toBeLessThanOrEqual(65_536 + 20)
  }, 20_000)
})
