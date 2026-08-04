export * as SessionWorkerEntrypoint from "./entrypoint"

import { createInterface } from "node:readline"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionWorkerClient } from "./client"
import { SessionWorkerCapabilities } from "./capabilities"

export interface Context {
  readonly lease: SessionExecutionAttempt.Lease
  readonly location: (typeof SessionWorkerProtocol.Start.Type)["location"]
  readonly force: boolean
  readonly signal: AbortSignal
  readonly capabilities: SessionWorkerCapabilities.Capabilities
  readonly phase: (phase: (typeof SessionWorkerProtocol.Heartbeat.Type)["phase"]) => void
}

export interface Input {
  readonly drain: (context: Context) => Promise<void>
  readonly heartbeatIntervalMs?: number
  readonly classifyError?: (error: unknown) => { readonly classification: string; readonly detail?: string }
}

const identityOf = (start: typeof SessionWorkerProtocol.Start.Type) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: start.sessionID,
  attemptID: start.attemptID,
  generation: start.generation,
})

/** Standard child-process main loop. It accepts exactly one start envelope, owns interruption and
 * heartbeat emission, and tears down every pending host RPC before returning to the executable. */
export async function run(input: Input): Promise<"settled" | "interrupted" | "failed"> {
  // stdout is the framed worker protocol. Effect's default logger (and ordinary console calls in
  // adapters) otherwise inject prose into that channel and make a healthy worker look malformed.
  // Keep diagnostics visible on stderr, which the supervisor deliberately inherits.
  const stderr = (...args: unknown[]) => console.error(...args)
  console.log = stderr
  console.info = stderr
  console.debug = stderr
  const lines = createInterface({ input: process.stdin })
  const iterator = lines[Symbol.asyncIterator]()
  const first = await iterator.next()
  if (first.done) throw new Error("session worker stdin closed before start")
  const decoded = SessionWorkerProtocol.decodeHostLine(first.value)
  if (!decoded.ok || decoded.message.type !== "start") throw new Error("session worker expected a valid start envelope")
  const start = decoded.message
  const lease = { ...identityOf(start), ownerID: `worker_${process.pid}` }
  const abort = new AbortController()
  let phase: (typeof SessionWorkerProtocol.Heartbeat.Type)["phase"] = "drain"
  let rejectProtocol!: (error: Error) => void
  const protocolFailure = new Promise<never>((_resolve, reject) => {
    rejectProtocol = reject
  })
  const emit = (message: SessionWorkerProtocol.WorkerMessage) =>
    process.stdout.write(SessionWorkerProtocol.encodeLine(message))
  const client = SessionWorkerClient.make({ lease, send: emit })
  const capabilities = SessionWorkerCapabilities.make({ lease, client })

  const pump = async () => {
    for (;;) {
      const item = await iterator.next()
      if (item.done) throw new Error("session worker host connection closed")
      const next = SessionWorkerProtocol.decodeHostLine(item.value)
      if (!next.ok) throw new Error(next.error)
      if (!SessionWorkerProtocol.owns(lease, next.message))
        throw new Error("session worker received a stale host message")
      if (next.message.type === "interrupt") {
        abort.abort(new Error("session worker interrupted"))
        return
      }
      if (next.message.type === "start") throw new Error("session worker received a second start envelope")
      if (!client.accept(next.message)) throw new Error(`unexpected host message: ${next.message.type}`)
    }
  }
  void pump().catch((error) => rejectProtocol(error instanceof Error ? error : new Error("worker protocol failed")))

  emit({ ...identityOf(start), type: "ready", workerPID: process.pid })
  const heartbeat = setInterval(
    () => emit({ ...identityOf(start), type: "heartbeat", phase, at: Date.now(), rssBytes: process.memoryUsage.rss() }),
    input.heartbeatIntervalMs ?? 1_000,
  )
  heartbeat.unref?.()

  try {
    await Promise.race([
      input.drain({
        lease,
        location: start.location,
        force: start.force,
        signal: abort.signal,
        capabilities,
        phase: (next) => {
          phase = next
        },
      }),
      protocolFailure,
    ])
    if (abort.signal.aborted) return "interrupted"
    emit({ ...identityOf(start), type: "settled" })
    return "settled"
  } catch (error) {
    if (abort.signal.aborted) return "interrupted"
    const failure = input.classifyError?.(error) ?? {
      classification: "worker-failure",
      detail: error instanceof Error ? error.message : "unknown worker failure",
    }
    emit({ ...identityOf(start), type: "failed", ...failure })
    return "failed"
  } finally {
    clearInterval(heartbeat)
    client.close(new Error("session worker drain ended"))
    lines.close()
  }
}
