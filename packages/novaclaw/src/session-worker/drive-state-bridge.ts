export * as SessionWorkerDriveStateBridge from "./drive-state-bridge"

import { Effect } from "effect"
import { SessionDriveState } from "@novaclaw/core/session/runner/drive-state"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "drive-state-request" }>
export type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "drive-state-result" }>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

const ok = (message: Request, value?: unknown): Reply => ({
  ...identity(message),
  type: "drive-state-result",
  outcome: "ok",
  ...(value === undefined ? {} : { value }),
})

const rejected = (message: Request, reason: string): Reply => ({
  ...identity(message),
  type: "drive-state-result",
  outcome: "rejected",
  reason,
})

/**
 * Serve ONE drive-state operation from the host's store and answer the worker.
 *
 * 🔴 **This is what makes the runner's "session-scoped" maps session-scoped.** The worker's
 * `SessionDriveState.node` replacement turns its hydrate into a `load` and every mutation into a
 * `save`; this is the other end, and the store it reaches is the host's — the one process that
 * outlives a drain. The session is pinned against the store's idle sweep for the worker's whole
 * life by `execution.ts`, not here: a request-scoped pin would let the sweep run between two
 * requests of one drain.
 *
 * ⚠️ The session id is the LEASE's, never the message's. A worker speaks for its own session and
 * for nobody else's, structurally; `owns` rejects a message that names another session or a
 * superseded attempt before the store is touched.
 */
export const handle = Effect.fn("SessionWorkerDriveStateBridge.handle")(function* (input: {
  readonly store: SessionDriveState.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  const message = input.message
  if (!SessionWorkerProtocol.owns(input.lease, message)) return rejected(message, "execution ownership changed")
  const sessionID = input.lease.sessionID
  switch (message.op) {
    case "load":
      return yield* input.store.load(sessionID).pipe(Effect.map((snapshot) => ok(message, snapshot)))
    case "save": {
      const snapshot = SessionDriveState.decode(message.args[0])
      // A snapshot that lost a field in transit is refused, never stored: storing it would make the
      // next drain forget what this session opened, which is the defect this bridge exists to end.
      if (snapshot === undefined) return rejected(message, "drive state save carried a malformed snapshot")
      return yield* input.store.save(sessionID, snapshot).pipe(Effect.map(() => ok(message)))
    }
    default:
      return rejected(message, `unknown drive state op ${String(message.op satisfies never)}`)
  }
})
