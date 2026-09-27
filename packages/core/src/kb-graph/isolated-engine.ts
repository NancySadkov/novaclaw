import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import { createInterface } from "node:readline"
import { existsSync } from "node:fs"
import type { Engine } from "./memory-client"
import type { SnapshotRecovery, WasmMemory } from "./wasm-engine"

declare const NOVACLAW_STANDALONE_BINARY: boolean

export type GraphEngine = Engine & Pick<WasmMemory, "stagedCount" | "stagedScopes" | "close"> & {
  readonly recovery: SnapshotRecovery
  readonly publishBlocked: string | undefined
  readonly fault?: string | undefined
  /** The worker's own last reported footprint — see `DEFAULT_MAX_WORKER_RSS_BYTES`. */
  readonly workerRssBytes?: number | undefined
  readonly workerRssCeilingBytes?: number
}

type Reply =
  | { id: number; ok: true; value: unknown; publishBlocked?: string; rssBytes?: number }
  | { id: number; ok: false; error: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const MAX_QUEUED_REQUESTS = 64
const MAX_FRAME_BYTES = 16 * 1024 * 1024

/**
 * 🔴 WHEN THE WORKER'S MEMORY IS A REASON TO THROW IT AWAY AND START A NEW ONE.
 *
 * The graph engine is LadybugDB compiled to Wasm, and Wasm linear memory only grows — there is no
 * shrink. Measured 2026-09-27 on a copy of a real production store: `open` costs ~1.3 GB resident
 * for a store holding ZERO memories (871 MB external / 433 MB ArrayBuffer, JS heap under 15 MB), so
 * it is a FIXED arena rather than a function of the data. `close()` releases none of it, and the only
 * thing that returns it is process exit.
 *
 * Three wrong theories got here first — eighteen engines, eighteen retained generations, and an LRU
 * capped at two — each falsified by reading `world-memory.ts` (a closure singleton that opens once),
 * `snapshot.ts` (`candidates()` lists paths and copies nothing) and `memory-worker-node.ts` (the
 * worker `break`s and EXITS on close, so nothing is stranded). The engine does not cycle. One long
 * lived arena simply grows, and a live instance was caught at 2.8 GB idle and 15.6 GB after work,
 * the latter holding enough commit to take the box to 100 %.
 *
 * So the only lever that works is the process, and this is it: the worker reports its own RSS on
 * every reply, and crossing this line recycles it. The arena is returned by the exit, the next
 * request spawns a fresh worker, and the floor is one arena rather than an unbounded climb.
 *
 * ⚠️ A RECYCLE IS NOT A FAULT. A discarded worker records the reason as `fault`, which every later
 * call then refuses on — correct for a crash and wrong for a deliberate recycle, which would leave
 * memory permanently broken until the instance restarted. So this path clears the latch.
 */
export const DEFAULT_MAX_WORKER_RSS_BYTES = 3 * 1024 * 1024 * 1024

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
    shutdownTimeoutMs?: number
    /** Recycle the worker once its own reported footprint crosses this. See the constant above. */
    maxWorkerRssBytes?: number
  } = {},
): Promise<GraphEngine> => {
  let child: ChildProcessWithoutNullStreams | undefined
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
  const rssCeiling = transport.maxWorkerRssBytes ?? DEFAULT_MAX_WORKER_RSS_BYTES
  let lastRssBytes: number | undefined

  /**
   * Kill the worker when its own reported footprint has grown past the ceiling.
   *
   * ⚠️ Called BETWEEN requests, never while one is in flight. Doing it from the reply handler — the
   * obvious place, since that is where the number arrives — kills the child microseconds after
   * resolving a request, and the next `sendRaw` then reaches for a `stdin` that is gone. The first
   * version of this did exactly that and the test caught it as a hung request.
   */
  const recycleIfOversized = () => {
    if (lastRssBytes === undefined || !Number.isFinite(lastRssBytes)) return false
    if (lastRssBytes <= rssCeiling) return false
    const target = child
    if (!target) return false
    discard(target, `memory worker exceeded its memory ceiling (${Math.round(lastRssBytes / 1024 / 1024)} MB)`)
    // A recycle is not a fault: the fault latch makes every later call refuse, which would turn a
    // memory guard into a memory outage until the instance restarted.
    fault = undefined
    return true
  }

  const discard = (processToDiscard: ChildProcessWithoutNullStreams, reason: string) => {
    if (child !== processToDiscard) return
    child = undefined
    fault = reason
    for (const waiting of pending.values()) {
      clearTimeout(waiting.timer)
      waiting.reject(new Error(reason))
    }
    pending.clear()
    processToDiscard.kill()
  }

  const sendRaw = (processToUse: ChildProcessWithoutNullStreams, method: string, args: unknown[], timeoutMs: number) =>
    new Promise<unknown>((resolve, reject) => {
      const id = ++sequence
      const frame = JSON.stringify({ id, method, args }) + "\n"
      if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
        reject(new Error(`memory worker request is larger than ${MAX_FRAME_BYTES} bytes`))
        return
      }
      const timer = setTimeout(() => discard(processToUse, `memory worker timed out in ${method}`), timeoutMs)
      pending.set(id, { resolve, reject, timer })
      try {
        processToUse.stdin.write(frame, (error) => {
          if (error) discard(processToUse, `memory worker pipe failed: ${error.message}`)
        })
      } catch (error) {
        discard(processToUse, `memory worker pipe failed: ${String(error)}`)
      }
    })

  const start = () => {
    if (opening) return opening
    if (child) return Promise.resolve()
    opening = (async () => {
      const argv = transport.argv ?? command()
      const next = spawn(argv[0]!, argv.slice(1), {
        stdio: ["pipe", "pipe", "pipe"] as const,
        windowsHide: true,
        env: { ...process.env, ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}) },
      })
      child = next
      next.stderr.pipe(process.stderr, { end: false })
      const lines = createInterface({ input: next.stdout, crlfDelay: Infinity })
      lines.on("line", (line) => {
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
          // RECORDED here, acted on between requests. The worker's own footprint is the only number
          // that can decide the recycle, and it is the only portable way a parent learns it.
          if (typeof reply.rssBytes === "number" && Number.isFinite(reply.rssBytes)) lastRssBytes = reply.rssBytes
          waiting.resolve(reply.value)
        } else waiting.reject(new Error(reply.error))
      })
      next.on("error", (error) => discard(next, `memory worker failed: ${error.message}`))
      next.on("exit", (code) => discard(next, `memory worker exited (${code ?? "unknown"})`))
      const opened = await sendRaw(next, "open", [directory, options], 60_000)
      recovery = opened as SnapshotRecovery
      fault = undefined
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
      // The recycle happens HERE, on the seam between requests, where no reply is owed to anyone. The
      // arena is returned by the child's exit and `start()` below brings up a fresh one, so the floor
      // is a single arena rather than an unbounded climb.
      if (recycleIfOversized()) {
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

  await start()
  return {
    get recovery() { return recovery },
    get publishBlocked() { return publishBlocked },
    get fault() { return fault },
    /**
     * The worker's own last reported footprint, and the ceiling it is recycled against.
     *
     * Exposed because this number was invisible for as long as it mattered: a live instance held
     * 2.8 GB idle and 15.6 GB after work, and nothing in the product could see either. A cost nothing
     * can read is a cost nothing can act on.
     */
    get workerRssBytes() { return lastRssBytes },
    get workerRssCeilingBytes() { return rssCeiling },
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
      const timer = setTimeout(() => {
        if (child) discard(child, "memory worker shutdown timed out")
      }, transport.shutdownTimeoutMs ?? 10_000)
      try {
        await tail
      } finally {
        clearTimeout(timer)
      }
      const live = child
      if (!live) return
      await sendRaw(live, "close", [], transport.shutdownTimeoutMs ?? 10_000).catch(() => undefined)
      discard(live, "memory worker closed")
    })(),
  }
}
