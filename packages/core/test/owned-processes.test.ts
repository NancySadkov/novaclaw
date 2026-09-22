import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { OwnedProcesses } from "@novaclaw/core/util/owned-processes"

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function untilGone(pid: number, timeoutMs: number): Promise<boolean> {
  const stop = Date.now() + timeoutMs
  for (;;) {
    if (!alive(pid)) return true
    if (Date.now() >= stop) return !alive(pid)
    await sleep(50)
  }
}

const tracked: Array<{ child: ChildProcess; release: () => void }> = []

function startTracked(): { child: ChildProcess; release: () => void } {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30_000)"], { stdio: "ignore" })
  const release = OwnedProcesses.register(child)
  const entry = { child, release }
  tracked.push(entry)
  return entry
}

afterEach(() => {
  for (const entry of tracked.splice(0)) {
    entry.release()
    try {
      entry.child.kill("SIGKILL")
    } catch {}
  }
})

describe("OwnedProcesses", () => {
  test("register counts live entries and release drops them", () => {
    const before = OwnedProcesses.liveCount()
    const first = startTracked()
    const second = startTracked()
    expect(OwnedProcesses.liveCount()).toBe(before + 2)
    first.release()
    expect(OwnedProcesses.liveCount()).toBe(before + 1)
    second.release()
    expect(OwnedProcesses.liveCount()).toBe(before)
  })

  test("killAll terminates a registered running child", async () => {
    const { child, release } = startTracked()
    const pid = child.pid ?? -1
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    await OwnedProcesses.killAll()
    expect(await untilGone(pid, 10_000)).toBe(true)
    release()
  })

  test("killAllSync terminates a registered running child", async () => {
    const { child, release } = startTracked()
    const pid = child.pid ?? -1
    expect(pid).toBeGreaterThan(0)
    expect(alive(pid)).toBe(true)
    OwnedProcesses.killAllSync()
    expect(await untilGone(pid, 10_000)).toBe(true)
    release()
  })

  test("killAll with no entries of its own resolves", async () => {
    await OwnedProcesses.killAll()
    OwnedProcesses.killAllSync()
  })
})
