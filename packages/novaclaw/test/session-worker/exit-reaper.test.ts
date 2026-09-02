import { expect, test } from "bun:test"
import path from "node:path"
import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { activeWorkerCount, reapActiveWorkers, spawn } from "../../src/session-worker/supervisor"

/**
 * **A server that exits without being tree-killed must leave no session worker behind.**
 *
 * The covered exits are the ones somebody else tree-kills for us: supervised `serve` kills the inner
 * server with `taskkill /t`, which reaches its worker children. The uncovered ones are the server's
 * OWN exit — `serve --no-supervise` running out through `src/index.ts`'s `process.exit()`, and a fatal
 * in the server process. A worker that survives those keeps a connection to the live instance database
 * and a tool-subprocess tree of its own.
 *
 * ⚠️ **Why this is not a "start a host, kill it, look for the orphan" test.** It was written that way
 * first and it passed with the reaper deleted. Measured on win32: a non-`detached` child of a **bun**
 * parent joins a job object Windows tears down with the parent, so on this platform-and-runtime the OS
 * reaps the worker whatever we do — and the same probe with `detached: true` outlived its parent, which
 * is what pins the job object as the reason. Node creates no such job (the desktop sidecar is an
 * Electron `utilityProcess`, i.e. node) and no POSIX host has one, so the hole is real off this
 * configuration and invisible on it. A cross-process test here would be green because it is broken.
 *
 * So the two halves are asserted separately, and both can fail:
 *  · the reaper is REGISTERED on `process.on("exit")` by spawning a worker — `process.exit()` running
 *    `exit` hooks is a runtime guarantee (probed under both node and bun on 2026-09-02), so
 *    registration is the half that is ours;
 *  · the reaper KILLS — it is invoked and the worker is gone afterwards.
 *
 * ⚠️ `bun test` does not run `exit` hooks, which is the other reason this cannot be an end-to-end
 * assertion inside the runner.
 */

const fixture = path.resolve(import.meta.dir, "../fixtures/session-worker.ts")
const lease = {
  sessionID: SessionSchema.ID.make("ses_worker_exit_reaper"),
  attemptID: "exe_worker_exit_reaper",
  generation: 1,
  ownerID: "host-test",
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test("spawning a worker registers the exit reaper, and the reaper tree-kills what is live", async () => {
  const worker = spawn({
    command: [process.execPath, fixture, "silent"],
    lease,
    directory: process.cwd(),
    force: false,
    startupTimeoutMs: 8_000,
    // Far past this test: the worker must die because the reaper ran, not because the supervisor's
    // own liveness deadline happened to fire first.
    heartbeatTimeoutMs: 120_000,
  })

  try {
    // The fixture stays alive and silent, so this is only true once the child is genuinely running.
    for (let attempt = 0; attempt < 80 && !alive(worker.pid); attempt++) await delay(25)
    expect(alive(worker.pid)).toBe(true)
    expect(activeWorkerCount()).toBeGreaterThan(0)

    // Half one: the hook is on the real event, so a `process.exit()` anywhere reaches it.
    expect(process.listeners("exit").includes(reapActiveWorkers)).toBe(true)

    // Half two: what the hook does.
    reapActiveWorkers()
    let survived = true
    for (let attempt = 0; attempt < 80 && survived; attempt++) {
      survived = alive(worker.pid)
      if (survived) await delay(25)
    }
    expect(survived).toBe(false)
    expect(activeWorkerCount()).toBe(0)
  } finally {
    // Whatever the assertions decided, this test leaves no process behind.
    killTreeSync(worker.pid)
  }
}, 30_000)
