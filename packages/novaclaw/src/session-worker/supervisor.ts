import { killTreeSync } from "@novaclaw/core/util/kill-tree"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { AbsolutePath } from "@novaclaw/core/schema"
import type { Location } from "@novaclaw/core/location"
import childProcess from "node:child_process"
import type { Readable } from "node:stream"

export type Outcome =
  | { readonly type: "settled" }
  | { readonly type: "failed"; readonly classification: string; readonly detail?: string }
  | { readonly type: "start-timeout" }
  | { readonly type: "heartbeat-timeout" }
  | { readonly type: "memory-limit"; readonly rssBytes: number; readonly limitBytes: number }
  | { readonly type: "protocol-error"; readonly detail: string }
  | { readonly type: "stale-message" }
  | { readonly type: "exited"; readonly code: number }
  | { readonly type: "signaled"; readonly signal: NodeJS.Signals }
  | { readonly type: "interrupted" }

export interface Input {
  readonly command: readonly string[]
  readonly lease: SessionExecutionAttempt.Lease
  readonly directory: string
  readonly workspaceID?: Location.Ref["workspaceID"]
  readonly force: boolean
  readonly env?: Record<string, string | undefined>
  readonly startupTimeoutMs?: number
  readonly heartbeatTimeoutMs?: number
  readonly interruptGraceMs?: number
  readonly cleanupTimeoutMs?: number
  readonly memoryLimitBytes?: number
  readonly onMessage?: (message: SessionWorkerProtocol.WorkerMessage) => void
  readonly onHeartbeat?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "heartbeat" }>,
    signal: AbortSignal,
  ) => Promise<void>
  readonly onPublishEvent?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "publish-event" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "event-published" | "event-rejected" }>>
  readonly onDeviceRequest?: (
    message: Extract<
      SessionWorkerProtocol.WorkerMessage,
      { readonly type: "device-admit" | "device-release" | "device-report" }
    >,
    signal: AbortSignal,
  ) => Promise<
    Extract<
      SessionWorkerProtocol.HostMessage,
      { readonly type: "device-admitted" | "device-released" | "device-reported" | "device-rejected" }
    >
  >
  readonly onInteractionRequest?: (
    message: Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "permission-assert" | "question-ask" }>,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "permission-result" | "question-result" }>>
  readonly onExecutionRequest?: (
    message: SessionWorkerProtocol.ExecutionRequest,
    signal: AbortSignal,
  ) => Promise<Extract<SessionWorkerProtocol.HostMessage, { readonly type: "execution-result" }>>
  readonly onExit?: (outcome: Outcome) => Promise<void>
}

export interface Handle {
  readonly pid: number
  readonly result: Promise<Outcome>
  readonly interrupt: () => Promise<Outcome>
  readonly send: (message: SessionWorkerProtocol.HostMessage) => void
}

const STARTUP_TIMEOUT_MS = 15_000
const HEARTBEAT_TIMEOUT_MS = 15_000
const INTERRUPT_GRACE_MS = 2_000
const CLEANUP_TIMEOUT_MS = 2_000
const MONITOR_INTERVAL_MS = 100
const activePIDs = new Set<number>()

/** Process-count diagnostic and a testable lazy-lifetime invariant: an idle session owns no worker. */
export const activeWorkerCount = () => activePIDs.size

/** One child, one lease, one drain. This owns process lifetime only; event/device/interaction/execution RPC is
 * layered on top. Every terminal path tree-kills the worker so a tool subprocess cannot outlive
 * the fault domain that launched it. */
export function spawn(input: Input): Handle {
  if (input.command.length === 0) throw new Error("Session worker command is empty")
  const child = childProcess.spawn(input.command[0]!, input.command.slice(1), {
    cwd: input.directory,
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, ...input.env } as Record<string, string>,
    windowsHide: true,
  })
  if (child.pid === undefined || child.stdin === null || child.stdout === null)
    throw new Error("Session worker process did not expose its control pipes")
  const childPID = child.pid
  activePIDs.add(childPID)
  const startedAt = Date.now()
  let lastHeartbeat = startedAt
  let ready = false
  let done = false
  let interruptRequested = false
  let monitor: ReturnType<typeof setInterval> | undefined
  let resolveResult!: (outcome: Outcome) => void
  let rpcTail = Promise.resolve()
  const lifetime = new AbortController()
  const result = new Promise<Outcome>((resolve) => {
    resolveResult = resolve
  })

  const finish = (outcome: Outcome) => {
    if (done) return
    done = true
    activePIDs.delete(childPID)
    lifetime.abort()
    if (monitor) clearInterval(monitor)
    killTreeSync(childPID)
    const cleanup = Promise.resolve().then(() => input.onExit?.(outcome))
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, input.cleanupTimeoutMs ?? CLEANUP_TIMEOUT_MS)
    })
    void Promise.race([cleanup.catch(() => undefined), deadline]).then(() => {
      if (deadlineTimer) clearTimeout(deadlineTimer)
      resolveResult(outcome)
    })
  }

  const send = (message: SessionWorkerProtocol.HostMessage) => {
    if (done) return
    if (!SessionWorkerProtocol.owns(input.lease, message)) {
      finish({ type: "protocol-error", detail: "host attempted to send a stale worker message" })
      return
    }
    try {
      child.stdin.write(SessionWorkerProtocol.encodeLine(message))
    } catch {
      finish({ type: "protocol-error", detail: "failed to write worker message" })
    }
  }

  const queueRPC = (requestID: string, run: () => Promise<SessionWorkerProtocol.HostMessage>) => {
    rpcTail = rpcTail
      .then(async () => {
        if (done) return
        const reply = await run()
        if (!("requestID" in reply) || reply.requestID !== requestID) {
          finish({ type: "protocol-error", detail: "RPC reply request id does not match" })
          return
        }
        send(reply)
      })
      .catch(() => finish({ type: "protocol-error", detail: "worker RPC failed" }))
  }

  const accept = (message: SessionWorkerProtocol.WorkerMessage) => {
    if (!SessionWorkerProtocol.owns(input.lease, message)) {
      finish({ type: "stale-message" })
      return
    }
    input.onMessage?.(message)
    switch (message.type) {
      case "ready":
        ready = true
        lastHeartbeat = Date.now()
        return
      case "heartbeat":
        if (!ready) {
          finish({ type: "protocol-error", detail: "heartbeat arrived before ready" })
          return
        }
        lastHeartbeat = Date.now()
        if (
          message.rssBytes !== undefined &&
          input.memoryLimitBytes !== undefined &&
          message.rssBytes > input.memoryLimitBytes
        ) {
          finish({ type: "memory-limit", rssBytes: message.rssBytes, limitBytes: input.memoryLimitBytes })
          return
        }
        if (input.onHeartbeat)
          void input
            .onHeartbeat(message, lifetime.signal)
            .catch(() => finish({ type: "protocol-error", detail: "failed to persist worker heartbeat" }))
        return
      case "settled":
        finish({ type: "settled" })
        return
      case "failed":
        finish({
          type: "failed",
          classification: message.classification,
          ...(message.detail === undefined ? {} : { detail: message.detail }),
        })
        return
      case "publish-event": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "event publication arrived before ready" })
          return
        }
        const publish = input.onPublishEvent
        if (!publish) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "event-rejected",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            error: "event publication is unavailable",
          })
          return
        }
        // One promise chain is the transcript ordering gate. Even if an RPC handler awaits disk,
        // the next publish cannot overtake it and receive an earlier durable sequence.
        queueRPC(message.requestID, () => publish(message, lifetime.signal))
        return
      }
      case "device-admit":
      case "device-release":
      case "device-report": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "device request arrived before ready" })
          return
        }
        const request = input.onDeviceRequest
        if (!request) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "device-rejected",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            error: "device arbitration is unavailable",
          })
          return
        }
        queueRPC(message.requestID, () => request(message, lifetime.signal))
        return
      }
      case "permission-assert":
      case "question-ask": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "interaction request arrived before ready" })
          return
        }
        const request = input.onInteractionRequest
        if (!request) {
          send(
            message.type === "permission-assert"
              ? {
                  version: SessionWorkerProtocol.VERSION,
                  type: "permission-result",
                  sessionID: input.lease.sessionID,
                  attemptID: input.lease.attemptID,
                  generation: input.lease.generation,
                  requestID: message.requestID,
                  outcome: "rejected",
                }
              : {
                  version: SessionWorkerProtocol.VERSION,
                  type: "question-result",
                  sessionID: input.lease.sessionID,
                  attemptID: input.lease.attemptID,
                  generation: input.lease.generation,
                  requestID: message.requestID,
                  outcome: "rejected",
                },
          )
          return
        }
        queueRPC(message.requestID, () => request(message, lifetime.signal))
        return
      }
      case "execution-advance":
      case "execution-tool-dispatched":
      case "execution-tool-settled":
      case "execution-provider-started":
      case "execution-provider-tool-protocol":
      case "execution-provider-settled":
      case "execution-provider-recovery":
      case "execution-context-updated": {
        if (!ready) {
          finish({ type: "protocol-error", detail: "execution request arrived before ready" })
          return
        }
        const request = input.onExecutionRequest
        if (!request) {
          send({
            version: SessionWorkerProtocol.VERSION,
            type: "execution-result",
            sessionID: input.lease.sessionID,
            attemptID: input.lease.attemptID,
            generation: input.lease.generation,
            requestID: message.requestID,
            outcome: "rejected",
            error: "execution checkpoint service is unavailable",
          })
          return
        }
        queueRPC(message.requestID, () => request(message, lifetime.signal))
        return
      }
    }
  }

  void readLines(child.stdout, (line) => {
    const decoded = SessionWorkerProtocol.decodeWorkerLine(line)
    if (!decoded.ok) {
      finish({ type: "protocol-error", detail: decoded.error })
      return
    }
    accept(decoded.message)
  }).catch(() => finish({ type: "protocol-error", detail: "failed to read worker output" }))

  child.once("exit", (code, signal) => {
    if (!done)
      finish(
        interruptRequested
          ? { type: "interrupted" }
          : signal
            ? { type: "signaled", signal }
            : { type: "exited", code: code ?? 1 },
      )
  })

  const startupTimeoutMs = input.startupTimeoutMs ?? STARTUP_TIMEOUT_MS
  const heartbeatTimeoutMs = input.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
  monitor = setInterval(
    () => {
      const now = Date.now()
      if (!ready && now - startedAt > startupTimeoutMs) finish({ type: "start-timeout" })
      else if (ready && now - lastHeartbeat > heartbeatTimeoutMs) finish({ type: "heartbeat-timeout" })
    },
    Math.min(MONITOR_INTERVAL_MS, startupTimeoutMs, heartbeatTimeoutMs),
  )
  monitor.unref?.()

  send({
    version: SessionWorkerProtocol.VERSION,
    type: "start",
    sessionID: input.lease.sessionID,
    attemptID: input.lease.attemptID,
    generation: input.lease.generation,
    location: {
      directory: AbsolutePath.make(input.directory),
      ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
    },
    force: input.force,
  })

  const interrupt = async () => {
    if (done) return result
    interruptRequested = true
    send({
      version: SessionWorkerProtocol.VERSION,
      type: "interrupt",
      sessionID: input.lease.sessionID,
      attemptID: input.lease.attemptID,
      generation: input.lease.generation,
    })
    const grace = setTimeout(() => finish({ type: "interrupted" }), input.interruptGraceMs ?? INTERRUPT_GRACE_MS)
    grace.unref?.()
    const outcome = await result
    clearTimeout(grace)
    return outcome
  }

  return { pid: childPID, result, interrupt, send }
}

async function readLines(stream: Readable, onLine: (line: string) => void) {
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true })
    for (;;) {
      const newline = pending.indexOf("\n")
      if (newline < 0) break
      const line = pending.slice(0, newline).replace(/\r$/, "")
      pending = pending.slice(newline + 1)
      if (new TextEncoder().encode(line).byteLength > SessionWorkerProtocol.MAX_LINE_BYTES)
        throw new Error("worker line exceeds limit")
      if (line) onLine(line)
    }
    if (new TextEncoder().encode(pending).byteLength > SessionWorkerProtocol.MAX_LINE_BYTES)
      throw new Error("worker line exceeds limit")
  }
  pending += decoder.decode()
  if (pending) onLine(pending)
}
