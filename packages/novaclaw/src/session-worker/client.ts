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
      | "device-maintenance-admit"
      | "device-maintenance-release"
      | "device-maintenance-await-preemption"
      | "permission-assert"
      | "spawn-child"
      | "await-child"
      | "colleague-request"
      | "memory-request"
      | "local-model-request"
      | "drive-state-request"
      | "execution-advance"
      | "execution-tool-dispatched"
      | "execution-tool-settled"
      | "execution-provider-started"
      | "execution-provider-tool-protocol"
      | "execution-provider-settled"
      | "execution-provider-recovery"
      | "execution-served-by"
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
      | "device-maintenance-admitted"
      | "device-maintenance-released"
      | "device-maintenance-preempted"
      | "device-rejected"
      | "permission-result"
      | "spawn-result"
      | "await-child-result"
      | "colleague-result"
      | "memory-result"
      | "local-model-result"
      | "drive-state-result"
      | "execution-result"
  }
>

const replyTypes: Record<Request["type"], ReadonlySet<Reply["type"]>> = {
  "publish-event": new Set(["event-published", "event-rejected"]),
  "device-admit": new Set(["device-admitted", "device-rejected"]),
  "device-release": new Set(["device-released", "device-rejected"]),
  "device-report": new Set(["device-reported", "device-rejected"]),
  "device-maintenance-admit": new Set(["device-maintenance-admitted", "device-rejected"]),
  "device-maintenance-release": new Set(["device-maintenance-released", "device-rejected"]),
  "device-maintenance-await-preemption": new Set(["device-maintenance-preempted", "device-rejected"]),
  "permission-assert": new Set(["permission-result"]),
  "spawn-child": new Set(["spawn-result"]),
  "await-child": new Set(["await-child-result"]),
  "colleague-request": new Set(["colleague-result"]),
  "memory-request": new Set(["memory-result"]),
  "local-model-request": new Set(["local-model-result"]),
  "drive-state-request": new Set(["drive-state-result"]),
  "execution-advance": new Set(["execution-result"]),
  "execution-tool-dispatched": new Set(["execution-result"]),
  "execution-tool-settled": new Set(["execution-result"]),
  "execution-provider-started": new Set(["execution-result"]),
  "execution-provider-tool-protocol": new Set(["execution-result"]),
  "execution-provider-settled": new Set(["execution-result"]),
  "execution-provider-recovery": new Set(["execution-result"]),
  "execution-served-by": new Set(["execution-result"]),
  "execution-context-updated": new Set(["execution-result"]),
}

interface Pending {
  readonly expected: ReadonlySet<Reply["type"]>
  readonly resolve: (reply: Reply) => void
  readonly reject: (error: Error) => void
}

export interface Client {
  readonly request: (message: Request) => Promise<Reply>
  /** Returns false for lifecycle/control messages that belong to the worker entrypoint. */
  readonly accept: (message: SessionWorkerProtocol.HostMessage) => boolean
  readonly close: (reason?: Error) => void
  readonly pendingCount: () => number
}

/** Correlates worker RPCs without granting the child any host-owned authority. Identity is checked on
 * both directions, response kinds are paired to request kinds, and teardown rejects every waiter.
 *
 * 🔴 **`request` takes NO `AbortSignal`, and that is load-bearing rather than an omission.** Every
 * method here and on `Capabilities` carried an optional `signal?` until 2026-09-01 (). No
 * production caller ever supplied one — interruption in the worker travels through Effect
 * (`session-worker-node.ts`'s `runtime.runPromise(..., { signal })`), not through these — and the
 * path it enabled was actively harmful: `abort` deleted the pending entry while the HOST was still
 * processing that RPC, so the eventual reply arrived for a requestID no longer pending, and
 * `accept`'s unknown-id branch below `close()`s the transport. One cancelled call became a dead
 * worker, failing every other in-flight RPC with it.
 *
 * ⚠️ **So the unknown-id `close()` in `accept` is only sound BECAUSE nothing can abort.** With no
 * abort, a reply for an unknown id genuinely is a protocol violation and tearing down is right.
 * Re-introduce cancellation and that stops being true — `accept` would first need to distinguish
 * "aborted, ignore the late reply" from "the host invented an id", which is state this client does
 * not keep. Do not add the signal back without adding that. */
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
      item.reject(reason)
    }
    pending.clear()
  }

  const request = (message: Request) => {
    if (closed) return Promise.reject(closed)
    if (!SessionWorkerProtocol.owns(input.lease, message))
      return Promise.reject(new Error("worker attempted a stale RPC request"))
    if (pending.has(message.requestID))
      return Promise.reject(new Error(`duplicate worker RPC id: ${message.requestID}`))

    return new Promise<Reply>((resolve, reject) => {
      pending.set(message.requestID, { expected: replyTypes[message.type], resolve, reject })
      try {
        input.send(message)
      } catch (error) {
        pending.delete(message.requestID)
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
    item.resolve(message as Reply)
    return true
  }

  return { request, accept, close, pendingCount: () => pending.size }
}
