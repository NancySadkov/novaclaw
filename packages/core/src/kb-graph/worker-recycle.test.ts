import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { open, DEFAULT_MAX_WORKER_HELD_BYTES } from "./isolated-engine"

/**
 * 🔴 THE MEMORY WORKER IS RECYCLED WHEN ITS FOOTPRINT CROSSES THE CEILING.
 *
 * The graph engine is LadybugDB compiled to Wasm, and Wasm linear memory only grows. Measured
 * 2026-09-27 on a copy of a real production store: `WasmMemory.open` costs ~1.3 GB resident for a
 * store holding ZERO memories — 871 MB external, 433 MB of that ArrayBuffer, JS heap under 15 MB — so
 * it is a fixed arena, not a function of the data. `close()` released none of it, and process exit was
 * the only thing that returned it. A live instance measured 2.8 GB idle and 15.6 GB after work; the
 * latter held enough commit to take the box to 100 % and get the user's browser and editor reaped.
 *
 * Three wrong theories were falsified before this one, and the tests below exist so the next reader
 * does not repeat them: the engine is a CLOSURE SINGLETON that opens once (`world-memory.ts`),
 * `snapshot.candidates()` only lists paths and copies nothing, and the worker BREAKS AND EXITS on
 * close (`memory-worker-node.ts`) so nothing is stranded by a close-then-continue. The arena simply
 * grows inside one long-lived process.
 *
 * So the fix is the only lever that works — recycle the PROCESS.
 *
 * 🔴 **These cases no longer fake a footprint, and that is the point.** They used to drive the REAL
 * supervisor over its real stdin/stdout protocol against a fake worker whose "reported RSS" was a
 * number in a file, because "the child reports its own RSS and the parent acts on it" was the design.
 * That design is the defect: working set is a number the operating system may shrink, so a long-lived
 * arena that has grown without bound reports itself as small. The parent now reads committed memory
 * from outside (`ProcessCommit`), so the child reports nothing and there is nothing left to fake — the
 * ceiling is moved past the real process instead, which is both simpler and the thing being tested.
 */

const MB = 1024 * 1024
/** `process.execPath`, not a bare `bun` — PATH is not the same for a spawned child on Windows. */
const BUN = process.execPath

/**
 * A ceiling no real process can be under, and one every real process is over.
 *
 * ⚠️ Both are absurd on purpose. The measurement is of a REAL child now, so the only way to place the
 * bound deterministically is to place the CEILING: 1 GB is above any Node/Bun process and 1 byte is
 * below any process that has allocated anything. Asserting on the child's exact byte count instead
 * would be asserting on the host's memory manager, which is not what this file is about.
 */
const UNREACHABLE_CEILING = 1024 * 1024 * 1024
const ALWAYS_EXCEEDED_CEILING = 1

/** A fake `__memory-worker`: speaks the protocol, and reports NO footprint — because it has none to report. */
function fakeWorker(): { path: string; dir: string; exits: () => number } {
  const dir = mkdtempSync(join(tmpdir(), "mem-worker-"))
  const path = join(dir, "worker.mjs")
  const log = join(dir, "exits")
  writeFileSync(
    path,
    `import { appendFileSync } from "node:fs"
const log = ${JSON.stringify(log)}
let buffer = ""
process.stdin.on("data", (chunk) => {
  buffer += chunk
  let i
  while ((i = buffer.indexOf("\\n")) !== -1) {
    const line = buffer.slice(0, i)
    buffer = buffer.slice(i + 1)
    const request = JSON.parse(line)
    if (request.method === "close") {
      appendFileSync(log, "x")
      process.exit(0)
    }
    process.stdout.write(JSON.stringify({ id: request.id, ok: true, value: { opened: request.args[0] } }) + "\\n")
  }
})`,
  )
  return {
    path,
    dir,
    exits: () => {
      try {
        return readFileSyncSyncCount(log)
      } catch {
        return 0
      }
    },
  }
}

function readFileSyncSyncCount(path: string): number {
  return require("node:fs").readFileSync(path, "utf8").length
}

/**
 * A scratch store, removed AFTER the work finishes.
 *
 * ⚠️ `async` is load-bearing and the first version omitted it. A non-async wrapper runs its `finally`
 * the moment the callback RETURNS — which, for an async callback, is a pending promise — so the
 * directory was deleted out from under the running worker. That showed up as one test hanging for no
 * visible reason while its two siblings passed, which is exactly the kind of failure that gets
 * misread as a product bug.
 */
const withDir = async <T>(fn: (dir: string) => Promise<T>): Promise<T> => {
  const dir = mkdtempSync(join(tmpdir(), "kbmem-store-"))
  mkdirSync(join(dir, "g0"), { recursive: true })
  writeFileSync(join(dir, "g0", "graph"), "")
  try {
    return await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("memory worker recycling", () => {
  test("a worker under the ceiling is left alone, and its footprint is now READ, not reported", async () => {
    const worker = fakeWorker()
    try {
      await withDir(async (dir) => {
        const engine = await open(join(dir, "g0", "graph"), {}, { argv: [BUN, worker.path], maxWorkerHeldBytes: UNREACHABLE_CEILING })
        await engine.search({ query: "anything" })
        // A real reading of a real process, taken from outside it. Before the fix this number came
        // from the child and the test asserted the child's own fiction.
        expect(engine.workerHeldBytes).toBeGreaterThan(0)
        expect(["commit", "rss"]).toContain(engine.workerHeldMetric as string)
        expect(engine.fault).toBeUndefined()
        await engine.close()
      })
    } finally {
      rmSync(worker.dir, { recursive: true, force: true })
    }
  })

  test("🔴 crossing the ceiling recycles the worker and does NOT latch a fault", async () => {
    // The fault latch is the subtlety. `discard` records a reason that every later call refuses on,
    // which is right for a crash and wrong for a deliberate recycle: it would leave memory broken
    // until the instance restarted, turning a memory guard into a memory outage.
    const worker = fakeWorker()
    try {
      await withDir(async (dir) => {
        const engine = await open(join(dir, "g0", "graph"), {}, { argv: [BUN, worker.path], maxWorkerHeldBytes: ALWAYS_EXCEEDED_CEILING })
        // Recycled, so the fault is cleared and the next request is served by a FRESH worker.
        expect(engine.fault).toBeUndefined()
        const answer = await engine.search({ query: "after the recycle" })
        expect(answer).toBeDefined()
        expect(engine.fault).toBeUndefined()
        await engine.close()
        // The old worker really did exit — that is what returns the arena.
        expect(worker.exits()).toBeGreaterThan(0)
      })
    } finally {
      rmSync(worker.dir, { recursive: true, force: true })
    }
  })

  test("the answer to the request that crossed the ceiling is still delivered", async () => {
    // A recycle that fails in-flight work turns a memory bound into data loss. The reply is resolved
    // FIRST and the ceiling applied after, so a request that succeeded is never retroactively failed.
    const worker = fakeWorker()
    try {
      await withDir(async (dir) => {
        const engine = await open(join(dir, "g0", "graph"), {}, { argv: [BUN, worker.path], maxWorkerHeldBytes: ALWAYS_EXCEEDED_CEILING })
        try {
          const answer = await engine.search({ query: "must still answer" })
          expect(answer).toBeDefined()
        } catch (error) {
          throw new Error(
            `search rejected: ${JSON.stringify(String(error))} | held=${engine.workerHeldBytes} fault=${engine.fault}`,
          )
        }
        await engine.close()
      })
    } finally {
      rmSync(worker.dir, { recursive: true, force: true })
    }
  })

  test("the default ceiling is a real number, and it is a ceiling rather than a target", () => {
    // Pinned so a change to it is a decision. It sits above the measured 1.3 GB open cost and the
    // 2.8 GB idle reading, and below the 15.6 GB that took the machine down.
    expect(DEFAULT_MAX_WORKER_HELD_BYTES).toBe(3 * 1024 * 1024 * 1024)
    expect(DEFAULT_MAX_WORKER_HELD_BYTES).toBeGreaterThan(2.8 * 1024 * MB)
    expect(DEFAULT_MAX_WORKER_HELD_BYTES).toBeLessThan(15.6 * 1024 * MB)
  })
})
