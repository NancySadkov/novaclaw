import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  BUILD_MEMORY_LIMIT_BYTES,
  BUILD_NODE_HEAP_MB,
  buildAllocationLimit,
  buildEnvironment,
  buildMemoryBoundary,
} from "./build-memory"

test("the heap budget leaves memory for native allocations, tools and supervisors", () => {
  expect(BUILD_MEMORY_LIMIT_BYTES).toBe(1280 * 1024 ** 2)
  expect(BUILD_NODE_HEAP_MB * 1024 ** 2).toBeLessThan(BUILD_MEMORY_LIMIT_BYTES)
  expect(buildEnvironment({ NODE_OPTIONS: "--max-old-space-size=8192" }).NODE_OPTIONS).toBe(
    "--max-old-space-size=576 --max-semi-space-size=8",
  )
  expect(buildEnvironment({ UV_THREADPOOL_SIZE: "64" }).UV_THREADPOOL_SIZE).toBe("2")
})

test("a caller cannot raise or disable the memory boundary", async () => {
  for (const bytes of [0, -1, NaN, Infinity, BUILD_MEMORY_LIMIT_BYTES + 1])
    await expect(buildMemoryBoundary(bytes)).rejects.toThrow()
})

test("Windows denies child allocations against the combined parent and child budget", async () => {
  if (process.platform !== "win32") return
  const child = Bun.spawn([process.execPath, "--smol", import.meta.dir + "/fixtures/build-memory-probe.ts"], {
    env: buildEnvironment(),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const deadline = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout)
    expect(result.limitBytes).toBe(buildAllocationLimit(1024 * 1024 ** 2))
    expect(result.child.denied).toBe(true)
    expect(result.child.allocatedBytes).toBeLessThan(result.limitBytes - result.parentHeldBytes)
    expect(result.peakBytes).toBeLessThanOrEqual(1024 * 1024 ** 2)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
  }
})

test("an environment marker cannot bypass the kernel boundary", async () => {
  if (process.platform !== "win32") return
  for (const marker of [undefined, "Local\\NovaClaw.InvalidBuildBoundary"]) {
    const env = { ...process.env }
    delete env.NOVACLAW_BUILD_MEMORY_JOB
    if (marker) env.NOVACLAW_BUILD_MEMORY_JOB = marker
    const child = Bun.spawn([process.execPath, import.meta.dir + "/../bounded-build.ts", "--verify"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain(marker ? "OpenJobObjectW failed" : "requires an inherited process tree memory boundary")
  }
})

test("the Windows wrapper's native job also denies aggregate child allocations", async () => {
  if (process.platform !== "win32") return
  const directory = mkdtempSync(resolve(import.meta.dir, "../../tmp/build-memory-"))
  const script = resolve(directory, "allocate.bat")
  writeFileSync(
    script,
    `@echo off\r\n"${process.execPath}" "${import.meta.dir}/fixtures/build-memory-probe.ts" allocate\r\nexit /b %errorlevel%\r\n`,
  )
  const child = Bun.spawn(
    [
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      resolve(import.meta.dir, "../bounded-build.ps1"),
      "-BuildScript",
      script,
    ],
    { env: { ...process.env, CI: "true" }, stdout: "pipe", stderr: "pipe", windowsHide: true },
  )
  const deadline = setTimeout(() => child.kill(), 15_000)
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect(exitCode, stderr).toBe(0)
    const result = JSON.parse(stdout.split(/\r?\n/).find((line) => line.startsWith("{"))!)
    expect(result.denied).toBe(true)
    expect(result.limitBytes).toBe(buildAllocationLimit(BUILD_MEMORY_LIMIT_BYTES))
    const memory = readFileSync(resolve(import.meta.dir, "../../tmp/build-memory.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .find((entry) => entry.command[0] === script)
    expect(memory.peakBytes).toBeLessThanOrEqual(BUILD_MEMORY_LIMIT_BYTES)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
    rmSync(directory, { recursive: true, force: true })
  }
}, 20_000)
