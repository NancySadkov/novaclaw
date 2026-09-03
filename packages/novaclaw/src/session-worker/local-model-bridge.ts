export * as SessionWorkerLocalModelBridge from "./local-model-bridge"

import { Effect } from "effect"
import type { LocalModelManager } from "@novaclaw/core/local-model-manager"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<SessionWorkerProtocol.WorkerMessage, { readonly type: "local-model-request" }>
export type Reply = Extract<SessionWorkerProtocol.HostMessage, { readonly type: "local-model-result" }>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

const ok = (message: Request): Reply => ({ ...identity(message), type: "local-model-result", outcome: "ok" })

const failed = (message: Request, reason: string): Reply => ({
  ...identity(message),
  type: "local-model-result",
  outcome: "failed",
  reason,
})

const rejected = (message: Request, reason: string): Reply => ({
  ...identity(message),
  type: "local-model-result",
  outcome: "rejected",
  reason,
})

/**
 * The one argument `ensure` carries, read as a whole or refused. A request that lost its
 * `apiModelID` in transit would make `ensure` a no-op on the host (the guard there compares it to
 * the managed profile), so the worker would be told "ok" about a model that was never started.
 * Refusing is the answer a caller can act on; guessing is not.
 */
const decodeRequest = (raw: unknown): LocalModelManager.ModelRequest | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.providerID !== "string" || typeof value.modelID !== "string" || typeof value.apiModelID !== "string")
    return undefined
  if (value.baseURL !== undefined && typeof value.baseURL !== "string") return undefined
  if (value.context !== undefined && typeof value.context !== "number") return undefined
  return {
    providerID: value.providerID,
    modelID: value.modelID,
    apiModelID: value.apiModelID,
    ...(value.baseURL === undefined ? {} : { baseURL: value.baseURL }),
    ...(value.context === undefined ? {} : { context: value.context }),
  }
}

/**
 * Run ONE local-model operation on the host's runtime and answer the worker.
 *
 * 🔴 **This is what makes "one llama.cpp child per instance" true inside a turn.** The worker's
 * `LocalModelManager.node` replacement turns its per-turn `ensure` into a `local-model-request`;
 * this is the other end, and the runtime it reaches is the one `LocalModelRuntime.managerNode` gives
 * the Instance controls and every location's model resolver. Before it, each worker process built
 * its own runtime — its own `state`, `child`, `loading` — so `ensure` in a fresh process could never
 * see the host's engine as already ready, and spawned a second server on the same fixed port.
 *
 * ⚠️ The switch is exhaustive over `LOCAL_MODEL_OPS` on purpose: `op satisfies never` in the default
 * arm turns "somebody added an op to the protocol" into a compile error here, not a runtime
 * rejection the worker reads as an outage.
 */
export const handle = Effect.fn("SessionWorkerLocalModelBridge.handle")(function* (input: {
  readonly manager: LocalModelManager.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  const message = input.message
  if (!SessionWorkerProtocol.owns(input.lease, message)) return rejected(message, "execution ownership changed")
  const args = message.args
  switch (message.op) {
    case "ensure": {
      const request = decodeRequest(args[0])
      if (request === undefined) return rejected(message, "local model ensure carried a malformed model request")
      const overrides = args[1] as Parameters<LocalModelManager.Interface["ensure"]>[1]
      return yield* input.manager.ensure(request, overrides).pipe(
        Effect.match({
          onFailure: (error: LocalModelManager.UnavailableError) => failed(message, error.message),
          onSuccess: () => ok(message),
        }),
      )
    }
    default:
      return rejected(message, `unknown local model op ${String(message.op satisfies never)}`)
  }
})
