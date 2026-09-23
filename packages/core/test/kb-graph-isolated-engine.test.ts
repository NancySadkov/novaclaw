import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as IsolatedMemory from "@novaclaw/core/kb-graph/isolated-engine"

let directory: string | undefined
let engine: Awaited<ReturnType<typeof IsolatedMemory.open>> | undefined

afterEach(async () => {
  await engine?.close()
  engine = undefined
  if (directory) rmSync(directory, { recursive: true, force: true })
  directory = undefined
})

test("the graph runs across a process boundary and remains usable", async () => {
  directory = mkdtempSync(join(tmpdir(), "kb-isolated-"))
  engine = await IsolatedMemory.open(join(directory, "graph"), { dim: 8 })
  await engine.addMemory({ id: "isolated", kind: "episode", text: "safe", scope: "agent:nova" })
  await engine.addMemory({ id: "second", kind: "episode", text: "still safe", scope: "agent:nova" })
  expect((await engine.get("isolated"))?.text).toBe("safe")
  expect(await engine.stagedCount("agent:nova")).toBe(2)
  expect((await engine.candidates({ scopes: ["agent:nova"] })).map((row) => row.id)).toEqual(["isolated", "second"])
  expect((await engine.candidates({ scopes: ["agent:nova"], limit: 1, offset: 1 })).map((row) => row.id)).toEqual(["second"])
}, 60_000)

test("worker commands resolve in desktop, bundled Node, standalone, and source runtimes", () => {
  const base = { executable: "runtime", sourceWorker: "source-worker.ts", standalone: false }
  const desktopEntry = join("app", "out", "main", "sidecar.js")
  expect(IsolatedMemory.commandFor({ ...base, entry: desktopEntry, electron: true })).toEqual([
    "runtime", join(dirname(desktopEntry), "server-runtime", "novaclaw-memory-worker.js"),
  ])
  const nodeEntry = join("dist", "node", "node.js")
  expect(IsolatedMemory.commandFor({ ...base, entry: nodeEntry, electron: false })).toEqual([
    "runtime", join(dirname(nodeEntry), "memory-worker-node.js"),
  ])
  expect(IsolatedMemory.commandFor({ ...base, entry: "serve", electron: false, standalone: true })).toEqual([
    "runtime", "__memory-worker",
  ])
  expect(IsolatedMemory.commandFor({ ...base, entry: "src/index.ts", electron: false })).toEqual([
    "runtime", "source-worker.ts",
  ])
})

test("a wedged worker cannot grow an unbounded server queue or hang shutdown", async () => {
  directory = mkdtempSync(join(tmpdir(), "kb-wedged-"))
  const fixture = fileURLToPath(new URL("./fixture/memory-worker-hang.ts", import.meta.url))
  engine = await IsolatedMemory.open(join(directory, "graph"), {}, {
    argv: [process.execPath, fixture], requestTimeoutMs:500, shutdownTimeoutMs:500,
  })
  const queued = Array.from({ length: 64 }, (_, index) => engine!.get(`queued-${index}`))
  await expect(engine.get("overflow")).rejects.toThrow("memory worker is busy")
  await engine.close()
  expect((await Promise.allSettled(queued)).every((result) => result.status === "rejected")).toBe(true)
}, 10_000)

test("the next request respawns a crashed graph worker", async () => {
  directory = mkdtempSync(join(tmpdir(), "kb-crash-"))
  const fixture = fileURLToPath(new URL("./fixture/memory-worker-crash.ts", import.meta.url))
  engine = await IsolatedMemory.open(join(directory, "graph"), {}, {
    argv: [process.execPath, fixture, join(directory, "crashed")],
  })
  await expect(engine.get("recovered")).rejects.toThrow("memory worker exited")
  expect(engine.fault).toContain("memory worker exited")
  expect((await engine.get("recovered"))?.text).toBe("the worker recovered")
  expect(engine.fault).toBeUndefined()
}, 10_000)
