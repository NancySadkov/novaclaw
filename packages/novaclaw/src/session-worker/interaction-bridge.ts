export * as SessionWorkerInteractionBridge from "./interaction-bridge"

import { Cause, Effect, Exit, Schema } from "effect"
import { PermissionV2 } from "@novaclaw/core/permission"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionWorkerProtocol } from "@novaclaw/core/session/execution/worker-protocol"
import type { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"

export type Request = Extract<
  SessionWorkerProtocol.WorkerMessage,
  { readonly type: "permission-assert" | "spawn-child" | "await-child" | "colleague-request" }
>
export type Reply = Extract<
  SessionWorkerProtocol.HostMessage,
  {
    readonly type: "permission-result" | "spawn-result" | "await-child-result" | "colleague-result"
  }
>

const identity = (message: Request) => ({
  version: SessionWorkerProtocol.VERSION,
  sessionID: message.sessionID,
  attemptID: message.attemptID,
  generation: message.generation,
  requestID: message.requestID,
})

/** Permission decisions and child operations execute in the authoritative host services. */
export const handle = Effect.fn("SessionWorkerInteractionBridge.handle")(function* (input: {
  readonly permission: PermissionV2.Interface
  readonly spawner: SessionSpawner.Interface
  readonly join: SessionJoin.Interface
  readonly colleague: ColleagueHandoff.Interface
  readonly lease: SessionExecutionAttempt.Lease
  readonly message: Request
}) {
  const reject = () =>
    input.message.type === "colleague-request"
      ? ({ ...identity(input.message), type: "colleague-result" as const, outcome: "rejected" as const } as Reply)
      : input.message.type === "await-child"
        ? ({ ...identity(input.message), type: "await-child-result" as const, outcome: "rejected" as const } as Reply)
        : input.message.type === "spawn-child"
          ? ({ ...identity(input.message), type: "spawn-result" as const, outcome: "rejected" as const } as Reply)
          : ({ ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const } as Reply)
  if (!SessionWorkerProtocol.owns(input.lease, input.message)) return reject()

  /**
   * 🔴 The whole reason this message exists. `spawn` creates a child session record and admits the
   * child's first input — two events carrying an id that is NOT this worker's lease, which
   * `event-bridge.ts` rejects by design. So the worker asks and the HOST spawns, under host
   * authority.
   *
   * ⚠️ `parentID` comes from the LEASE and never from the payload. A worker can spawn children of
   * itself and of nothing else, and that is structural — there is no field to forge.
   */
  /**
   * ⚠️ The only request that BLOCKS. The host tails the child's durable stream until it completes or
   * the worker's budget elapses; a timeout is a normal answer, because the child may still be working.
   * The direct-child authorisation check is NOT here — it stays in `tool/wait.ts`, where the session
   * store is readable on both sides of the boundary.
   */
  if (input.message.type === "await-child") {
    const joined = yield* input.join
      .awaitCompletion({ childID: input.message.input.childID, timeoutMs: input.message.input.timeoutMs })
      .pipe(Effect.exit)
    if (!Exit.isSuccess(joined)) return reject()
    return joined.value.completed
      ? {
          ...identity(input.message),
          type: "await-child-result" as const,
          outcome: "completed" as const,
          ...(joined.value.result === undefined ? {} : { result: joined.value.result }),
        }
      : { ...identity(input.message), type: "await-child-result" as const, outcome: "timeout" as const }
  }

  if (input.message.type === "spawn-child") {
    const spawned = yield* input.spawner
      .spawn({ ...input.message.input, parentID: input.lease.sessionID } as never)
      .pipe(Effect.exit)
    if (Exit.isSuccess(spawned))
      return {
        ...identity(input.message),
        type: "spawn-result" as const,
        outcome: "spawned" as const,
        child: spawned.value.id,
        started: spawned.value.started,
      }
    const failure = Cause.squash(spawned.cause)
    // A quota refusal is a NORMAL answer the tool reports to the model, not a transport rejection —
    // collapsing them would tell a model it hit a limit when its worker was actually stale.
    if (failure instanceof SessionSpawner.SpawnLimitError)
      return {
        ...identity(input.message),
        type: "spawn-result" as const,
        outcome: "limit" as const,
        reason: failure.reason,
        depth: failure.depth,
        limit: failure.limit,
      }
    return reject()
  }

  /**
   * 🔴 The same crossing as `spawn-child`, for the same reason: a COLLEAGUE's chat is not this
   * worker's session, so admitting its input publishes an event carrying an id that is not the
   * lease — which `event-bridge.ts` rejects by design. The worker asks; the host delivers.
   *
   * ⚠️ The SENDER comes from the lease and never from the payload. A worker can speak as itself and
   * as nobody else, structurally — there is no field to forge, exactly as `spawn-child` has no
   * `parentID`.
   *
   * ⚠️ And the host resolves WHICH chat. The worker names a colleague, never a session id, so it
   * cannot address a conversation it happened to learn the id of.
   */
  if (input.message.type === "colleague-request") {
    const request = input.message.input
    if (request.op === "hire") {
      // 🔴 THE LEASE, never the request. The tool's `mayStaff` check runs INSIDE the worker, so it is
      // the worker checking itself; the host must decide from something the worker cannot choose. The
      // lease is that — it is what this worker was granted, and `event-bridge` already refuses any
      // event whose session id is not it. The handoff derives the AGENT from it host-side.
      const hired = yield* input.colleague
        .hire({
          title: request.title,
          brief: request.brief,
          ...(request.personality === undefined ? {} : { personality: request.personality }),
          bySession: input.lease.sessionID,
        })
        .pipe(Effect.exit)
      if (!Exit.isSuccess(hired)) return reject()
      return {
        ...identity(input.message),
        type: "colleague-result" as const,
        outcome: "hired" as const,
        hiredID: hired.value.id,
        hiredName: hired.value.name,
      }
    }
    if (request.op === "retire") {
      const retired = yield* input.colleague.retire(request.colleague).pipe(Effect.exit)
      if (!Exit.isSuccess(retired)) return reject()
      return { ...identity(input.message), type: "colleague-result" as const, outcome: "retired" as const }
    }
    if (request.op === "set_superior") {
      const organized = yield* input.colleague
        .setSuperior({ colleague: request.colleague, superior: request.superior, bySession: input.lease.sessionID })
        .pipe(Effect.exit)
      if (!Exit.isSuccess(organized)) return reject()
      return {
        ...identity(input.message),
        type: "colleague-result" as const,
        outcome: organized.value ? ("organized" as const) : ("organization-refused" as const),
      }
    }
    if (request.op === "ask_group") {
      const group = yield* input.colleague
        .deliverGroup({ from: input.lease.sessionID, colleagues: request.colleagues, message: request.message })
        .pipe(Effect.exit)
      if (!Exit.isSuccess(group)) return reject()
      // Same non-flattening rule as the 1:1 arm below: a bound refusal carries its sentence, because
      // the tool never sees the host's `GroupDelivery` — it sees this message.
      if (group.value.refused !== undefined)
        return {
          ...identity(input.message),
          type: "colleague-result" as const,
          outcome: "refused" as const,
          reason: group.value.refused,
        }
      if (group.value.delivered.length === 0)
        return { ...identity(input.message), type: "colleague-result" as const, outcome: "no-chat" as const }
      return {
        ...identity(input.message),
        type: "colleague-result" as const,
        outcome: "group-delivered" as const,
        delivered: group.value.delivered,
        missing: group.value.missing,
        started: group.value.started,
        ...(group.value.conversation === undefined ? {} : { conversation: group.value.conversation }),
      }
    }
    const delivered = yield* input.colleague
      .deliver({ from: input.lease.sessionID, colleague: request.colleague, message: request.message })
      .pipe(Effect.exit)
    if (!Exit.isSuccess(delivered)) return reject()
    if (delivered.value.delivered)
      return {
        ...identity(input.message),
        type: "colleague-result" as const,
        outcome: "delivered" as const,
        started: delivered.value.started,
      }
    // 🔴 TWO reasons a hand-off did not land, and the bridge must not flatten them. `refused` is the
    // loop bound (`session/colleague-bound.ts`) and carries the sentence the sender needs to read;
    // `no-chat` is a colleague with nowhere to be written to. Collapsing both into "no open chat" —
    // which this did — would have reported every bound as a missing chat, and the mechanism would
    // have been invisible to the only reader that can act on it.
    if (delivered.value.refused !== undefined)
      return {
        ...identity(input.message),
        type: "colleague-result" as const,
        outcome: "refused" as const,
        reason: delivered.value.refused,
      }
    // Not a failure: that colleague simply has no open chat to leave this in, and the model must
    // say so rather than retry something that cannot succeed.
    return { ...identity(input.message), type: "colleague-result" as const, outcome: "no-chat" as const }
  }

  // Past the spawn branch, every remaining message carries its own `sessionID` and must match the
  // lease. `spawn-child` and `colleague-ask` deliberately have no such field — that is why they are
  // handled above.
  if (input.message.input.sessionID !== input.lease.sessionID) return reject()

  let asserted: PermissionV2.AssertInput
  try {
    asserted = Schema.decodeUnknownSync(PermissionV2.AssertInput)(input.message.input)
  } catch {
    return { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
  }
  const result = yield* input.permission.assert({ ...asserted, sessionID: input.lease.sessionID }).pipe(Effect.exit)
  if (Exit.isSuccess(result))
    return { ...identity(input.message), type: "permission-result" as const, outcome: "allowed" as const }
  const error = Cause.squash(result.cause)
  if (error instanceof PermissionV2.DeniedError)
    return {
      ...identity(input.message),
      type: "permission-result" as const,
      outcome: "denied" as const,
      rules: error.rules,
      ...(error.reason === undefined ? {} : { reason: error.reason }),
    }
  if (typeof error === "object" && error !== null && "_tag" in error && error._tag === "Session.NotFoundError")
    return { ...identity(input.message), type: "permission-result" as const, outcome: "session-missing" as const }
  return { ...identity(input.message), type: "permission-result" as const, outcome: "rejected" as const }
})
