import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"

import { awaitChildExit, STDIO_DRAIN_GRACE_MS } from "./child-exit"

/**
 * 🔴 **These spawn REAL processes on purpose.** The defect being pinned is not a branch in this
 * file, it is an interaction between a killed parent, a surviving grandchild and libuv's pipe
 * bookkeeping — none of which a mock has an opinion about. It cost a 36-minute hang to find; a test
 * that stubs the child would have been green throughout that hang.
 *
 * ⚠️ **Nothing here kills anything, and that is deliberate rather than sloppy.** "Do not spawn what
 * you will not reap" binds this file at least as hard as the one it tests — but the obvious way to
 * honour it is a hand-rolled `taskkill /T /F`, and `packages/core/test/kill-tree-ledger.test.ts`
 * scans `script/**` and fails any unledgered file that contains one. (It caught this file's first
 * draft, which is the ratchet doing exactly its job.) A harness script cannot import
 * `Shell.killTree` either — `script/` deliberately has no runtime edge into the kernel.
 *
 * So the leaked grandchild is made **self-limiting** instead: it sleeps a few seconds and exits on
 * its own, which reaps it by construction and needs no kill at all. The sleep only has to outlast
 * the assertion, which lands ~500 ms in.
 */
const GRANDCHILD_SLEEP_MS = 5_000

describe("awaiting a child that leaks a grandchild", () => {
  test("🔴 a grandchild holding the pipes must not hang the wait — it hung the gate for 36 minutes", async () => {
    // The exact shape of `bun test`'s parent+child pair: the grandchild inherits stdout/stderr, so
    // the pipes never reach EOF and `close` never fires, however dead the child is.
    // ⚠️ **The exact spawn shape is load-bearing and two earlier drafts of this test were GREEN
    // against a hazard they were not producing.** Measured with `tmp/probe-pipes.ts`, three ways of
    // leaking a grandchild behave differently: `Bun.spawn` with `stdio: 'inherit'` closes at 51 ms
    // and `child_process` with `'inherit'` at 58 ms — only `detached` with the raw descriptors
    // `[1, 2]` reproduces it, firing `exit` at 60 ms and NEVER firing `close`. Do not "simplify"
    // this to `inherit`: the test goes green and stops testing anything.
    //
    // The `process.exit` matters too — `Bun.spawn` refs its subprocess, so without it the parent
    // stays alive and the wait is *right* to keep waiting. The hazard needs the child genuinely
    // dead and the grandchild genuinely holding the pipes, which is what a SIGKILL produces.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `require('child_process').spawn(process.execPath,['-e','await Bun.sleep(${GRANDCHILD_SLEEP_MS})'],` +
          "{detached:true,stdio:['ignore',1,2]}).unref(); process.exit(7)",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
    child.stdout?.resume()
    child.stderr?.resume()
    const started = Date.now()
    const outcome = await awaitChildExit(child, 500)
    const elapsed = Date.now() - started

    // The whole claim: it ANSWERS. Before the fix this promise never settled.
    expect(elapsed).toBeLessThan(20_000)
    // …and it says the capture may be short rather than presenting a truncated log as a whole one.
    expect(outcome.drained).toBe(false)
  }, 30_000)

  test("an ordinary child still settles on `close`, complete and fast", async () => {
    const child = spawn(process.execPath, ["-e", "console.log('hi'); process.exit(3)"], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    let out = ""
    child.stdout?.on("data", (c: Buffer) => (out += c.toString()))
    const started = Date.now()
    const outcome = await awaitChildExit(child)
    // Well inside the grace window, which is what proves `close` — not the timer — settled it.
    expect(Date.now() - started).toBeLessThan(STDIO_DRAIN_GRACE_MS)
    expect(outcome).toEqual({ status: 3, drained: true })
    expect(out).toContain("hi")
  }, 30_000)

  test("🔴 a command that does not exist settles too, rather than waiting for a `close` that never comes", () => {
    // The same hang entered from the other side: some platforms emit no `close` after a spawn error.
    const child = spawn("this-command-does-not-exist-novaclaw", [], { stdio: ["ignore", "pipe", "pipe"] })
    return awaitChildExit(child).then((outcome) => {
      expect(outcome.status).toBeNull()
      expect(outcome.errno).toBeTruthy()
    })
  }, 30_000)
})
