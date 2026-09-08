import { expect, test } from "bun:test"
import { join } from "node:path"

test("WSL startup failure and normal stop await child closure", async () => {
  // Module mocks are process-global in Bun. Keep the OS transport fixture out of the desktop
  // suite's Electron and child-process modules by exercising the real adapter in a child runtime.
  const source = `
    import { mock, expect } from "bun:test"
    import { EventEmitter } from "node:events"
    import { PassThrough } from "node:stream"
    let child
    let healthy = false
    let killed = Promise.withResolvers()
    class Child extends EventEmitter {
      stdout = new PassThrough()
      stderr = new PassThrough()
      stdin = new PassThrough()
      kill() { killed.resolve(); return true }
    }
    const spawn = () => child = new Child()
    mock.module("electron", () => ({ app: { isPackaged: false } }))
    mock.module(${JSON.stringify(join(import.meta.dir, "runtime.ts"))}, () => ({
      resolveWslNovaclaw: async () => "/fixture/novaclaw",
      shellEscape: (s) => s,
      wslArgs: (args) => args,
    }))
    mock.module(${JSON.stringify(join(import.meta.dir, "../server.ts"))}, () => ({ checkHealth: async () => healthy }))
    const { spawnWslSidecar } = await import(${JSON.stringify(join(import.meta.dir, "sidecar.ts"))})
    console.log("adapter imported")
    let settled = false
    const failed = spawnWslSidecar("fixture", { healthTimeoutMs: 5, spawn })
    void failed.catch((error) => { settled = true; console.log(String(error)) })
    await killed.promise
    console.log("startup kill requested")
    await new Promise(setImmediate)
    expect(settled).toBe(false)
    child.emit("close", 1)
    await expect(failed).rejects.toThrow("health check timed out")
    console.log("startup failure settled")
    healthy = true
    killed = Promise.withResolvers()
    const running = await spawnWslSidecar("fixture", { spawn })
    console.log("healthy child acquired")
    settled = false
    const stopped = running.listener.stop()
    void stopped.then(() => { settled = true })
    await killed.promise
    expect(running.listener.stop()).toBe(stopped)
    await new Promise(setImmediate)
    expect(settled).toBe(false)
    child.emit("exit", 0)
    await new Promise(setImmediate)
    expect(settled).toBe(false)
    child.emit("close", 0)
    await stopped
    expect(settled).toBe(true)
    console.log("startup and stop observed closure")
  `
  const child = Bun.spawn([process.execPath, "--eval", source], { stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => child.kill(), 8_000)
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(code, stdout + stderr).toBe(0)
    expect(stdout).toContain("startup and stop observed closure")
  } finally {
    clearTimeout(timer)
    child.kill()
    await child.exited
  }
}, 10_000)
