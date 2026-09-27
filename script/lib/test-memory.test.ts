import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join, resolve } from "node:path"
import {
  allocationLimit,
  boundedTestHeadroom,
  linuxTestMemory,
  TEST_MEMORY_ALLOCATION_BYTES,
  TEST_MEMORY_LIMIT_BYTES,
  testMemoryLimit,
} from "./test-memory"
import { workspacePackageDirs } from "./typecheck-units"

const fixture = join(import.meta.dir, "fixtures/test-memory-probe.ts")
const root = resolve(import.meta.dir, "../..")
const windows = process.platform === "win32" ? test : test.skip

async function probe(mode: string) {
  const child = Bun.spawn([process.execPath, fixture, mode], { stdout: "pipe", stderr: "pipe", windowsHide: true })
  const deadline = setTimeout(() => child.kill(), 10_000)
  try {
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return { stdout, stderr, exit }
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill()
  }
}

describe("test memory boundary", () => {
  test("an override can only lower the hard limit", () => {
    expect(testMemoryLimit()).toBe(8 * 1024 ** 3)
    expect(testMemoryLimit(512 * 1024 ** 2)).toBe(512 * 1024 ** 2)
    expect(allocationLimit(TEST_MEMORY_LIMIT_BYTES)).toBe(TEST_MEMORY_ALLOCATION_BYTES)
    for (const value of [0, -1, NaN, Infinity, 1.5, TEST_MEMORY_LIMIT_BYTES + 1])
      expect(() => testMemoryLimit(value)).toThrow()
  })

  test("planning shares the hard allowance and still respects lower host headroom", () => {
    expect(boundedTestHeadroom({ commitBytes: 64 * 1024 ** 3, residentBytes: 3 })).toEqual({
      commitBytes: TEST_MEMORY_ALLOCATION_BYTES,
      residentBytes: 3,
    })
    expect(boundedTestHeadroom({ commitBytes: 3 })).toEqual({ commitBytes: 3 })
  })

  test("every test configuration arms the boundary before other preloads", () => {
    const configs = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--", "**/bunfig.toml", "bunfig.toml"],
      { cwd: root, encoding: "utf8", windowsHide: true },
    )
      .trim()
      .split(/\r?\n/)
    for (const directory of workspacePackageDirs(root)) expect(configs).toContain(`${directory}/bunfig.toml`)
    for (const file of configs) {
      const config = Bun.TOML.parse(readFileSync(join(root, file), "utf8")) as { test?: { preload?: string[] } }
      if (!config.test) continue
      const preload = config.test.preload?.[0]
      expect(preload, file).toBeDefined()
      expect(resolve(root, file, "..", preload!), file).toBe(join(root, "script/test-preload.ts"))
    }
    const runner = readFileSync(join(root, "script/test.ts"), "utf8")
    expect(runner.match(/^import .+$/m)?.[0]).toBe('import "./test-preload"')
  })

  test("Linux refuses unbounded memory or swap", () => {
    const read = (memory: string, swap: string) => (file: string) =>
      file === "/proc/self/cgroup" ? "0::/\n" : file.endsWith("memory.max") ? memory : swap
    expect(() => linuxTestMemory(read("max", "0"))).toThrow()
    expect(() => linuxTestMemory(read(String(TEST_MEMORY_LIMIT_BYTES), "max"))).toThrow()
    expect(() => linuxTestMemory(read(String(TEST_MEMORY_ALLOCATION_BYTES), "0"))).not.toThrow()
    expect(() => linuxTestMemory(read(String(TEST_MEMORY_LIMIT_BYTES), "0"))).toThrow()
    expect(() => linuxTestMemory(() => "")).toThrow()
  })

  windows("the installed kernel limit reserves headroom below 8 GiB, including inherited processes", async () => {
    const result = await probe("limits")
    expect(result.exit, result.stderr).toBe(0)
    const value = JSON.parse(result.stdout)
    expect(value.inherited).toBe(true)
    expect(value.shared.limitBytes).toBe(TEST_MEMORY_ALLOCATION_BYTES)
    expect(value.shared.flags & 0x200).toBe(0x200)
    expect(value.shared.flags & 0x1800).toBe(0)
  })

  windows("the kernel denies aggregate commit without a sampler or event-loop tick", async () => {
    const result = await probe("aggregate")
    expect(result.exit, result.stderr).toBe(0)
    const value = JSON.parse(result.stdout)
    expect(value.child.denied).toBe(true)
    expect(value.child.allocatedBytes).toBeGreaterThan(0)
    expect(value.parentHeld).toBe(96 * 1024 ** 2)
    expect(value.own.limitBytes).toBe(allocationLimit(768 * 1024 ** 2))
    expect(value.own.peakBytes).toBeLessThanOrEqual(768 * 1024 ** 2)
    console.log(
      `Kernel probe: ${value.child.allocatedBytes / 1024 ** 2} MiB child allocations; ${value.own.peakBytes / 1024 ** 2} MiB aggregate peak; 768 MiB budget`,
    )
  })

  windows("an invalid limit refuses before work begins", async () => {
    const result = await probe("invalid")
    expect(result.exit).not.toBe(0)
    expect(result.stderr).toContain("no greater than 8 GiB")
    expect(result.stdout).not.toContain("UNSAFE WORK STARTED")
  })

  windows("killing an owner also kills its non-Bun descendants", async () => {
    const owner = Bun.spawn([process.execPath, fixture, "orphan"], {
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    const deadline = setTimeout(() => owner.kill(), 10_000)
    try {
      const reader = owner.stdout.getReader()
      const ready = await reader.read()
      reader.releaseLock()
      const descendant = Number(new TextDecoder().decode(ready.value).trim())
      expect(descendant).toBeGreaterThan(0)
      expect(() => process.kill(descendant, 0)).not.toThrow()
      owner.kill()
      await owner.exited
      expect(() => process.kill(descendant, 0)).toThrow()
    } finally {
      clearTimeout(deadline)
      if (owner.exitCode === null) owner.kill()
    }
  })
})
