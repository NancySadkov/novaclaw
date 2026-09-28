import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { existsSync } from "node:fs"
import { ProcessCommit } from "@novaclaw/core/util/process-commit"
import type { Engine } from "./memory-client"
import type { SnapshotRecovery, WasmMemory } from "./wasm-engine"

declare const NOVACLAW_STANDALONE_BINARY: boolean

export type GraphEngine = Engine & Pick<WasmMemory, "stagedCount" | "stagedScopes" | "close"> & {
  readonly recovery: SnapshotRecovery
  readonly publishBlocked: string | undefined
  readonly fault?: string | undefined
  /**
   * The worker's footprint as measured FROM OUTSIDE it, and the ceiling it is recycled against.
   *
   * 🔴 These were `workerRssBytes`/`workerRssCeilingBytes` and they carried the worker's OWN reported
   * RSS. That number is the one the operating system may shrink, so a worker holding 6.32 GB of commit
   * while resident at 18.5 MB reported "tiny" and was never recycled — the same defect that let a
   * session worker run away, in the second place it appeared. The reading now comes from
   * `ProcessCommit`, and `workerHeldMetric` says whether it is commit or RSS, because "3 GB" means
   * different things on the two platforms.
   */
  readonly workerHeldBytes?: number | undefined
  readonly workerHeldMetric?: "commit" | "rss" | undefined
  readonly workerHeldCeilingBytes?: number
}

type Reply =
  | { id: number; ok: true; value: unknown; publishBlocked?: string }
  | { id: number; ok: false; error: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
type Worker = { process: ChildProcessWithoutNullStreams; exited: Promise<void> }
const MAX_QUEUED_REQUESTS = 64
const MAX_FRAME_BYTES = 16 * 1024 * 1024
const activeWorkers = new Set<ChildProcessWithoutNullStreams>()

process.once("exit", () => {
  for (const worker of activeWorkers) worker.kill("SIGKILL")
})

export const DEFAULT_MAX_WORKER_HELD_BYTES = 3 * 1024 * 1024 * 1024

export const commandFor = (input: {
  executable: string
  entry: string
  electron: boolean
  standalone: boolean
  sourceWorker: string
}): string[] => {
  if (input.standalone) return [input.executable, "__memory-worker"]
  const entry = input.entry
  const base = entry.replaceAll("\\", "/").split("/").at(-1)
  const worker =
    input.electron
      ? join(dirname(entry), "server-runtime", "novaclaw-memory-worker.js")
      : base === "novaclaw-server.js"
      ? join(dirname(entry), "novaclaw-memory-worker.js")
      : base === "node.js"
        ? join(dirname(entry), "memory-worker-node.js")
        : input.sourceWorker
  return [input.executable, worker]
}

const command = () => {
  const electron = process.versions.electron !== undefined
  const standalone = typeof NOVACLAW_STANDALONE_BINARY === "boolean" && NOVACLAW_STANDALONE_BINARY
  const sibling = fileURLToPath(new URL(electron ? "./novaclaw-memory-worker.js" : "./memory-worker-node.js", import.meta.url))
  if (!standalone && existsSync(sibling)) return [process.execPath, sibling]
  return commandFor({
    executable: process.execPath,
    entry: process.argv[1] ?? "",
    electron,
    standalone,
    sourceWorker: fileURLToPath(new URL("../../../novaclaw/src/memory-worker-node.ts", import.meta.url)),
  })
}

export const open = async (
  directory: string,
  options: { dim?: number } = {},
  transport: {
    argv?: readonly string[]
    requestTimeoutMs?: number
    openTimeoutMs?: number
    shutdownTimeoutMs?: number
    signal?: AbortSignal
    /** Recycle the worker once its own reported footprint crosses this. See the constant above. */
    maxWorkerHeldBytes?: number
  } = {},
): Promise<GraphEngine> => {
  let child: Worker | undefined
  let stopping = Promise.resolve()
  let opening: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let closed = false
  let sequence = 0
  let tail = Promise.resolve()
  let queued = 0
  let recovery: SnapshotRecovery = { opened: "(empty)", skipped: [], quarantined: [] }
  let publishBlocked: string | undefined
  let fault: string | undefined
  const pending = new Map<number, Pending>()
  const heldCeiling = transport.maxWorkerHeldBytes ?? DEFAULT_MAX_WORKER_HELD_BYTES
  let lastHeld: { bytes: number; metric: "commit" | "rss" } | undefined

  /**
   * Recycle the worker when its footprint, measured from OUTSIDE, crosses the ceiling.
   *
   * 🔴 `async` because the reading is no longer the child's to give. This used to read a number the
   * worker reported about itself, which is precisely the number a long-lived Wasm arena stops
   * reporting honestly: the arena grows, the process is trimmed, and the self-report says "fine".
   */
  const recycleIfOversized = async (): Promise<boolean> => {
    const target = child
    if (!target) return false
    const reading = await ProcessCommit.read(target.process.pid ?? -1)
    // `undefined` is UNKNOWN, not "under the ceiling" — see the note in `process-commit.ts`.
    if (reading === undefined) return false
    lastHeld = reading
    if (reading.bytes <= heldCeiling) return false
    discard(
      target,
      `memory worker exceeded its memory ceiling (${Math.round(reading.bytes / 1024 / 1024)} MB ${
        reading.metric === "commit" ? "committed" : "resident"
      })`,
    )
    fault = undefined
    return true
  }

  const discard = (worker: Worker, reason: string) => {
    if (child !== worker) return stopping
    child = undefined
    fault = reason
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
    }
    pending.clear()
    stopping = worker.exited
    worker.process.stderr.unpipe(process.stderr)
    worker.process.stdin.destroy()
    worker.process.kill("SIGKILL")
    worker.process.stdout.destroy()
    worker.process.stderr.destroy()
    return stopping
  }

  const sendRaw = (worker: Worker, method: string, args: unknown[], timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence
      const frame = JSON.stringify({ id, method, args }) + "\n"
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        reject(new Error(`memory worker request is larger than ${MAX_FRAME_BYTES} bytes`))
        return
      }
      const timer = setTimeout(() => discard(worker, `memory worker timed out in ${method}`), timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        worker.process.stdin.write(frame, (error) => {
          if (error) discard(worker, `memory worker pipe failed: ${error.message}`)
        })
      } catch (error) {
        discard(worker, `memory worker pipe failed: ${String(error)}`)
      }
    })

  const start = () => {
    if (opening) return opening
    if (child) return Promise.resolve()
    opening = (async () => {
      await stopping
      if (closed) throw new Error("memory worker is closed")
      const argv = transport.argv ?? command()
      const spawned = spawn(argv[0]!, argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"] as const,
        windowsHide: true,
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      })
      activeWorkers.add(spawned)
      const next: Worker = {
        process: spawned,
        exited: new Promise((resolve) => {
          const released = () => { activeWorkers.delete(spawned); resolve() }
          spawned.once("exit", released)
          spawned.once("error", () => { if (spawned.pid === undefined) released() })
        }),
      }
      child = next
      // The MEASURED footprint belonged to the worker that just went away, so it goes with it. Keeping
      // it would leave a stale reading standing in for a process that no longer exists.
      lastHeld = undefined
      spawned.stderr.pipe(process.stderr, { end: false })
      const lines = createInterface({ input: spawned.stdout, crlfDelay: Infinity })
      spawned.once("close", () => lines.close())
      lines.on("line", (line) => {
        if (child !== next) return
        let reply: Reply
        try {
          reply = JSON.parse(line) as Reply
        } catch {
          discard(next, "memory worker sent an invalid reply")
          return
        }
        const waiting = pending.get(reply.id)
        if (!waiting) return
        pending.delete(reply.id)
        clearTimeout(waiting.timer)
        if (reply.ok) {
          publishBlocked = reply.publishBlocked
          waiting.resolve(reply.value)
        } else waiting.reject(new Error(reply.error))
      })
      spawned.on("error", (error) => discard(next, `memory worker failed: ${error.message}`))
      spawned.stdin.on("error", (error) => discard(next, `memory worker pipe failed: ${error.message}`))
      spawned.on("exit", (code) => discard(next, `memory worker exited (${code ?? "unknown"})`))
      try {
        recovery = await sendRaw(next, "open", [directory, options], transport.openTimeoutMs ?? 60_000) as SnapshotRecovery
        if (closed) throw new Error("memory worker is closed")
        fault = undefined
      } catch (error) {
        await discard(next, String(error))
        throw error
      }
    })().finally(() => {
      opening = undefined
    })
    return opening
  }

  const request = <T>(method: string, ...args: unknown[]): Promise<T> => {
    if (closed) return Promise.reject(new Error("memory worker is closed"))
    if (queued >= MAX_QUEUED_REQUESTS) return Promise.reject(new Error("memory worker is busy"))
    queued++
    const operation = tail.then(async () => {
      if (closed) throw new Error("memory worker is closed")
      await start()
      if (await recycleIfOversized()) {
        await start()
        if (closed) throw new Error("memory worker is closed")
      }
      if (!child) throw new Error("memory worker is closed")
      return (await sendRaw(child, method, args, transport.requestTimeoutMs ?? 30_000)) as T
    })
    tail = operation.then(
      () => { queued-- },
      () => { queued-- },
    )
    return operation
  }

  const abort = () => {
    closed = true
    if (child) discard(child, "memory worker is closed")
  }
  transport.signal?.addEventListener("abort", abort, { once: true })
  if (transport.signal?.aborted) abort()
  try {
    await start()
  } catch (error) {
    transport.signal?.removeEventListener("abort", abort)
    throw error
  }
  return {
    get recovery() { return recovery },
    get publishBlocked() { return publishBlocked },
    get fault() { return fault },
    /**
     * The worker's last measured footprint, and the ceiling it is recycled against.
     *
     * ⚠️ Measured from outside the worker, because a cost the subject reports about itself is a cost
     * the product cannot act on. `workerHeldMetric` travels with the number so a reader is told whether
     * it is committed memory (Windows) or resident (Linux) rather than guessing.
     */
    get workerHeldBytes() { return lastHeld?.bytes },
    get workerHeldMetric() { return lastHeld?.metric },
    get workerHeldCeilingBytes() { return heldCeiling },
    addMemory: (input) => request("addMemory", input),
    addEdge: (input) => request("addEdge", input),
    search: (input) => request("search", input),
    neighbors: (id, options) => request("neighbors", id, options),
    get: (id, options) => request("get", id, options),
    path: (from, to, maxHops, options) => request("path", from, to, maxHops, options),
    invalidate: (id, at, options) => request("invalidate", id, at, options),
    purge: (id, options) => request("purge", id, options),
    addClaim: (input) => request("addClaim", input),
    claimHistory: (id, options) => request("claimHistory", id, options),
    reviewEvidence: (locator, options) => request("reviewEvidence", locator, options),
    setClaimStatus: (id, status, options) => request("setClaimStatus", id, status, options),
    moveScope: (from, to) => request("moveScope", from, to),
    clearScope: (scope) => request("clearScope", scope),
    eraseAll: () => request("eraseAll"),
    discardLegacyGlobalExtracts: () => request("discardLegacyGlobalExtracts"),
    stats: () => request("stats"),
    list: (input) => request("list", input),
    candidates: (input) => request("candidates", input),
    byIds: (ids) => request("byIds", ids),
    graph: (input) => request("graph", input),
    stagedCount: (scope) => request("stagedCount", scope),
    stagedScopes: (prefix) => request("stagedScopes", prefix),
    close: () => closing ??= (async () => {
      closed = true
      transport.signal?.removeEventListener("abort", abort)
      const timer = setTimeout(() => {
        if (child) discard(child, "memory worker shutdown timed out")
      }, transport.shutdownTimeoutMs ?? 10_000)
      try {
        await tail
      } finally {
        clearTimeout(timer)
      }
      const live = child
      if (live) {
        await sendRaw(live, "close", [], transport.shutdownTimeoutMs ?? 10_000).catch(() => undefined)
        await discard(live, "memory worker closed")
      }
      await stopping
    })(),
  }
}
