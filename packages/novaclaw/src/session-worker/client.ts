export * as SessionWorkerClient from "./client"

import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<
  SessionWorkerProtocol.WorkerMessage,
  {
    readonly type:
      | "publish-event"
      | "device-admit"
      | "device-release"
      | "device-report"
      | "permission-assert"
      | "question-ask"
      | "execution-advance"
      | "execution-tool-dispatched"
      | "execution-tool-settled"
      | "execution-provider-started"
      | "execution-provider-tool-protocol"
      | "execution-provider-settled"
      | "execution-provider-recovery"
      | "execution-context-updated"
  }
>

export type Reply = Extract<
  SessionWorkerProtocol.HostMessage,
  {
    readonly type:
      | "event-published"
      | "event-rejected"
      | "device-admitted"
      | "device-released"
      | "device-reported"
      | "device-rejected"
      | "permission-result"
      | "question-result"
      | "execution-result"
  }
>

const replyTypes: Record<Request["type"], ReadonlySet<Reply["type"]>> = {
  "publish-event": new Set(["event-published", "event-rejected"]),
  "device-admit": new Set(["device-admitted", "device-rejected"]),
  "device-release": new Set(["device-released", "device-rejected"]),
  "device-report": new Set(["device-reported", "device-rejected"]),
  "permission-assert": new Set(["permission-result"]),
  "question-ask": new Set(["question-result"]),
  "execution-advance": new Set(["execution-result"]),
  "execution-tool-dispatched": new Set(["execution-result"]),
  "execution-tool-settled": new Set(["execution-result"]),
  "execution-provider-started": new Set(["execution-result"]),
  "execution-provider-tool-protocol": new Set(["execution-result"]),
  "execution-provider-settled": new Set(["execution-result"]),
  "execution-provider-recovery": new Set(["execution-result"]),
  "execution-context-updated": new Set(["execution-result"]),
}

interface Pending {
  readonly expected: ReadonlySet<Reply["type"]>
  readonly resolve: (reply: Reply) => void
  readonly reject: (error: Error) => void
  readonly detachAbort?: () => void
}

export interface Client {
  readonly request: (message: Request, signal?: AbortSignal) => Promise<Reply>
  /** Returns false for lifecycle/control messages that belong to the worker entrypoint. */
  readonly accept: (message: SessionWorkerProtocol.HostMessage) => boolean
  readonly close: (reason?: Error) => void
  readonly pendingCount: () => number
}

/** Correlates worker RPCs without granting the child any host-owned authority. Identity is checked on
 * both directions, response kinds are paired to request kinds, and teardown rejects every waiter. */
export function make(input: {
  readonly lease: SessionExecutionAttempt.Lease
  readonly send: (message: Request) => void
}): Client {
  const pending = new Map<string, Pending>()
  let closed: Error | undefined

  const close = (reason = new Error("session worker transport closed")) => {
    if (closed) return
    closed = reason
    for (const item of pending.values()) {
      item.detachAbort?.()
      item.reject(reason)
    }
    pending.clear()
  }

  const request = (message: Request, signal?: AbortSignal) => {
    if (closed) return Promise.reject(closed)
    if (!SessionWorkerProtocol.owns(input.lease, message))
      return Promise.reject(new Error("worker attempted a stale RPC request"))
    if (pending.has(message.requestID))
      return Promise.reject(new Error(`duplicate worker RPC id: ${message.requestID}`))
    if (signal?.aborted) return Promise.reject(signal.reason)

    return new Promise<Reply>((resolve, reject) => {
      const abort = () => {
        pending.delete(message.requestID)
        reject(signal?.reason ?? new Error("worker RPC aborted"))
      }
      if (signal) signal.addEventListener("abort", abort, { once: true })
      pending.set(message.requestID, {
        expected: replyTypes[message.type],
        resolve,
        reject,
        ...(signal === undefined ? {} : { detachAbort: () => signal.removeEventListener("abort", abort) }),
      })
      try {
        input.send(message)
      } catch (error) {
        pending.delete(message.requestID)
        if (signal) signal.removeEventListener("abort", abort)
        reject(error instanceof Error ? error : new Error("failed to send worker RPC"))
      }
    })
  }

  const accept = (message: SessionWorkerProtocol.HostMessage) => {
    if (!("requestID" in message)) return false
    if (!SessionWorkerProtocol.owns(input.lease, message)) {
      close(new Error("host sent a stale worker RPC reply"))
      return true
    }
    const item = pending.get(message.requestID)
    if (!item) {
      close(new Error(`host sent an unknown worker RPC reply: ${message.requestID}`))
      return true
    }
    if (!item.expected.has(message.type)) {
      close(new Error(`host sent ${message.type} for an incompatible worker RPC`))
      return true
    }
    pending.delete(message.requestID)
    item.detachAbort?.()
    item.resolve(message as Reply)
    return true
  }

  return { request, accept, close, pendingCount: () => pending.size }
}
