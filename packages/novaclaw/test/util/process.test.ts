import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Process } from "@/util/process"
import { tmpdir } from "../fixture/fixture"

function node(script: string) {
  return [process.execPath, "-e", script]
}

describe("util.process", () => {
  test("captures stdout and stderr", async () => {
    const out = await Process.run(node('process.stdout.write("out");process.stderr.write("err")'))
    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toBe("out")
    expect(out.stderr.toString()).toBe("err")
  })

  test("returns code when nothrow is enabled", async () => {
    const out = await Process.run(node("process.exit(7)"), { nothrow: true })
    expect(out.code).toBe(7)
  })

  test("throws RunFailedError on non-zero exit", async () => {
    const err = await Process.run(node('process.stderr.write("bad");process.exit(3)')).catch((error) => error)
    expect(err).toBeInstanceOf(Process.RunFailedError)
    if (!(err instanceof Process.RunFailedError)) throw err
    expect(err.code).toBe(3)
    expect(err.stderr.toString()).toBe("bad")
  })

  test("aborts a running process", async () => {
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node("setInterval(() => {}, 1000)"), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  test("kills after timeout when process ignores terminate signal", async () => {
    if (process.platform === "win32") return

    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 25)

    const out = await Process.run(node('process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'), {
      abort: abort.signal,
      nothrow: true,
    })

    expect(out.code).not.toBe(0)
    expect(Date.now() - started).toBeLessThan(1000)
  }, 3000)

  /**
   * 🔴 **Aborting reaps the whole TREE, not just the process we hold a handle to.**
   *
   * `stop()` has always gone through `Shell.killTree`; the abort path used to signal the root pid and
   * schedule a `SIGKILL` on the same pid, which is the one thing that guarantees an orphan rather than
   * a reap. On Windows only `taskkill /t` reaches a grandchild at all, so a non-tree kill there leaves
   * the child running for as long as the box is up — this repository has lost a whole test-gate run to
   * exactly that.
   *
   * The parent below spawns an independent grandchild, writes its pid where the test can read it, and
   * then never exits on its own. Anything still alive at the end is killed by the `finally` arm: a test
   * about orphans must not leave one.
   *
   * ⚠️ **The grandchild is `detached`, and without that this test cannot fail.** On Windows libuv puts
   * every non-detached child in a JOB OBJECT that is killed when its creator's handle closes, so a
   * node-spawned grandchild dies with its parent whatever kill was used — measured here: with the
   * abort handler reverted to a root-only `proc.kill`, the non-detached version of this test still
   * passed. `detached` is what makes the grandchild outlive its parent, which is the state a real
   * leaked worker is in.
   */
  test("aborting kills the child's children, not only the child", async () => {
    await using tmp = await tmpdir()
    const pidFile = path.join(tmp.path, "grandchild.pid")

    const parent = [
      'const { spawn } = require("child_process");',
      'const fs = require("fs");',
      'const kid = spawn(process.execPath, ["-e", "setInterval(function () {}, 1000)"], { stdio: "ignore", detached: true });',
      "kid.unref();",
      "fs.writeFileSync(process.argv[1], String(kid.pid));",
      "setInterval(function () {}, 1000);",
    ].join("\n")

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        // EPERM means the pid exists and is not ours to signal; only ESRCH means it is gone.
        return (error as NodeJS.ErrnoException).code === "EPERM"
      }
    }

    const abort = new AbortController()
    const proc = Process.spawn([...node(parent), pidFile], { abort: abort.signal })

    let grandchild = 0
    try {
      for (let i = 0; i < 200 && grandchild === 0; i++) {
        const text = await fs.readFile(pidFile, "utf8").catch(() => "")
        grandchild = Number.parseInt(text, 10) || 0
        if (!grandchild) await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(grandchild).toBeGreaterThan(0)
      expect(alive(grandchild)).toBe(true)

      abort.abort()
      await proc.exited.catch(() => undefined)

      // The kill is not instantaneous on either platform (`taskkill` is a spawn; POSIX has a grace
      // window before SIGKILL), so give it a bounded window rather than a single sample.
      for (let i = 0; i < 200 && alive(grandchild); i++) {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      expect(alive(grandchild)).toBe(false)
    } finally {
      if (grandchild && alive(grandchild)) {
        try {
          process.kill(grandchild, "SIGKILL")
        } catch {
          /* already gone */
        }
      }
      await Process.stop(proc).catch(() => undefined)
    }
  }, 15000)

  test("uses cwd when spawning commands", async () => {
    await using tmp = await tmpdir()
    const out = await Process.run(node("process.stdout.write(process.cwd())"), {
      cwd: tmp.path,
    })
    expect(out.stdout.toString()).toBe(tmp.path)
  })

  test("merges environment overrides", async () => {
    const out = await Process.run(node('process.stdout.write(process.env.NOVACLAW_TEST ?? "")'), {
      env: {
        NOVACLAW_TEST: "set",
      },
    })
    expect(out.stdout.toString()).toBe("set")
  })

  test("uses shell in run on Windows", async () => {
    if (process.platform !== "win32") return

    const out = await Process.run(["set", "NOVACLAW_TEST_SHELL"], {
      shell: true,
      env: {
        NOVACLAW_TEST_SHELL: "ok",
      },
    })

    expect(out.code).toBe(0)
    expect(out.stdout.toString()).toContain("NOVACLAW_TEST_SHELL=ok")
  })

  test("runs cmd scripts with spaces on Windows without shell", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = Process.spawn([file, "--stdio"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })

    expect(await proc.exited).toBe(0)
  })

  test("rejects missing commands without leaking unhandled errors", async () => {
    await using tmp = await tmpdir()
    const cmd = path.join(tmp.path, "missing" + (process.platform === "win32" ? ".cmd" : ""))
    const err = await Process.spawn([cmd], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }).exited.catch((err) => err)

    expect(err).toBeInstanceOf(Error)
    if (!(err instanceof Error)) throw err
    expect(err).toMatchObject({
      code: "ENOENT",
    })
  })
})
