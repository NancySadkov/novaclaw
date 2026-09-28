import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { open } from "../src/kb-graph/isolated-engine"

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

test("every rejected acquisition reaps its worker before returning the error", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-worker-lifetime-"))
  const pidsFile = join(directory, "pids")
  const fixture = fileURLToPath(new URL("./fixture/memory-worker-open-failure.ts", import.meta.url))
  const pids = () => {
    try { return readFileSync(pidsFile, "utf8").trim().split("\n").map(Number) }
    catch { return [] }
  }
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(open(join(directory, "graph"), {}, {
        argv: [process.execPath, fixture, pidsFile],
      })).rejects.toThrow("graph initialization failed")
    }
    expect(pids()).toHaveLength(3)
    expect(pids().filter(alive)).toEqual([])
  } finally {
    for (const pid of pids()) if (alive(pid)) process.kill(pid, "SIGKILL")
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)

test("a timed out or aborted initialization releases the child before rejecting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-worker-cancel-"))
  const pidsFile = join(directory, "pids")
  const control = join(directory, "control")
  const fixture = fileURLToPath(new URL("./fixture/memory-worker-open-failure.ts", import.meta.url))
  writeFileSync(control, "hang")
  try {
    for (const signal of [undefined, AbortSignal.timeout(500)]) {
      await expect(open(join(directory, "graph"), {}, {
        argv: [process.execPath, fixture, pidsFile, control],
        openTimeoutMs: signal ? 5_000 : 250,
        signal,
      })).rejects.toThrow(signal ? "closed" : "timed out")
      expect(readFileSync(pidsFile, "utf8").trim().split("\n").map(Number).filter(alive)).toEqual([])
    }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)

test("failed recycling never overlaps generations and can recover", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kb-worker-reopen-"))
  const pidsFile = join(directory, "pids")
  const control = join(directory, "control")
  const fixture = fileURLToPath(new URL("./fixture/memory-worker-open-failure.ts", import.meta.url))
  writeFileSync(control, "ok")
  const engine = await open(join(directory, "graph"), {}, {
    argv: [process.execPath, fixture, pidsFile, control], maxWorkerHeldBytes: 1,
  })
  try {
    writeFileSync(control, "fail")
    await expect(engine.get("first")).rejects.toThrow("graph initialization failed")
    const pids = () => readFileSync(pidsFile, "utf8").trim().split("\n").map(Number)
    expect(pids()).toHaveLength(2)
    expect(pids().filter(alive)).toEqual([])
    writeFileSync(control, "ok")
    const answer = await engine.get("recovered")
    expect(pids().filter(alive)).toEqual([Number(answer?.id)])
    await engine.close()
    expect(pids().filter(alive)).toEqual([])
  } finally {
    await engine.close()
    rmSync(directory, { recursive: true, force: true })
  }
}, 10_000)

test("a spawn failure settles without leaving initialization pending", async () => {
  await expect(open("unused", {}, { argv: [join(tmpdir(), "missing-novaclaw-worker.exe")] }))
    .rejects.toThrow("memory worker failed")
}, 5_000)
