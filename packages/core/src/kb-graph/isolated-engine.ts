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
}

type Reply = { id: number; ok: true; value: unknown; publishBlocked?: string } | { id: number; ok: false; error: string }
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
const MAX_QUEUED_REQUESTS = 64
const MAX_FRAME_BYTES = 16 * 1024 * 1024

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
  transport: { argv?: readonly string[]; requestTimeoutMs?: number; shutdownTimeoutMs?: number } = {},
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
      if (closed) throw new Error("memory worker is closed")
      return (await sendRaw(child!, method, args, transport.requestTimeoutMs ?? 30_000)) as T
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
