export * as SessionWorkerProtocol from "./worker-protocol"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"
import { SessionSchema } from "../schema"
import type { SessionExecutionAttempt } from "../execution-attempt"
import { EventV2 } from "../../event"
import { Permission } from "@novaclaw/schema/permission"
import { Question } from "@novaclaw/schema/question"
import { Event } from "@novaclaw/schema/event"
import { Model } from "@novaclaw/schema/model"
import { SessionMessage } from "@novaclaw/schema/session-message"
import { SystemContext } from "../../system-context/index"
import { Location } from "../../location"

export const VERSION = 1 as const
export const MAX_LINE_BYTES = 1024 * 1024

const Identity = {
  version: Schema.Literal(VERSION),
  sessionID: SessionSchema.ID,
  attemptID: Schema.String,
  generation: PositiveInt,
}

export const Start = Schema.Struct({
  ...Identity,
  type: Schema.Literal("start"),
  location: Location.Ref,
  force: Schema.Boolean,
}).annotate({ identifier: "SessionWorker.Start" })

export const Interrupt = Schema.Struct({
  ...Identity,
  type: Schema.Literal("interrupt"),
}).annotate({ identifier: "SessionWorker.Interrupt" })

export const EventPublished = Schema.Struct({
  ...Identity,
  type: Schema.Literal("event-published"),
  requestID: Schema.String,
  eventID: EventV2.ID,
  durable: Schema.Struct({ aggregateID: Schema.String, seq: Schema.Int, version: Schema.Int }).pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.EventPublished" })

export const EventRejected = Schema.Struct({
  ...Identity,
  type: Schema.Literal("event-rejected"),
  requestID: Schema.String,
  error: Schema.String,
}).annotate({ identifier: "SessionWorker.EventRejected" })

const DeviceReplyBase = { ...Identity, requestID: Schema.String }
export const DeviceAdmitted = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-admitted"),
}).annotate({ identifier: "SessionWorker.DeviceAdmitted" })
export const DeviceReleased = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-released"),
}).annotate({ identifier: "SessionWorker.DeviceReleased" })
export const DeviceReported = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-reported"),
}).annotate({ identifier: "SessionWorker.DeviceReported" })
export const DeviceRejected = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-rejected"),
  error: Schema.String,
}).annotate({ identifier: "SessionWorker.DeviceRejected" })

export const PermissionResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("permission-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["allowed", "denied", "rejected", "corrected", "session-missing"]),
  rules: Permission.Ruleset.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
  feedback: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.PermissionResult" })

/**
 * The host's answer to a `spawn-child`.
 *
 * `outcome` mirrors the spawner's own contract rather than flattening it: a `limit` refusal is a
 * NORMAL result the tool reports to the model (depth/children/rate quotas), while `rejected` means the
 * request never reached the spawner — a stale lease or a parent that is not this worker's session.
 * Collapsing the two would tell a model it hit a quota when the truth is that its worker is stale.
 */
export const AwaitChildResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("await-child-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["completed", "timeout", "rejected"]),
  /** The child's rendered `exit(result)`; present only when `outcome` is "completed". */
  result: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.AwaitChildResult" })

/**
 * The host's answer to a `colleague-ask`.
 *
 * The three outcomes are three different facts and are deliberately not flattened: `delivered` means
 * it landed in their chat, `no-chat` means that colleague has no open conversation to leave it in
 * (the model must say so rather than retry), and `rejected` means the request never got that far —
 * a stale lease. Collapsing them would tell a model to retry a thing that cannot succeed.
 */
export const ColleagueResultMessage = Schema.Struct({
  ...Identity,
  type: Schema.Literal("colleague-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["delivered", "no-chat", "rejected"]),
  /** Whether anything is actually running their chat — `false` means durable but dormant. */
  started: Schema.Boolean.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.ColleagueResult" })

export const SpawnResultMessage = Schema.Struct({
  ...Identity,
  type: Schema.Literal("spawn-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["spawned", "limit", "rejected"]),
  /** Present only when `outcome` is "spawned". */
  child: SessionSchema.ID.pipe(Schema.optional),
  /** Whether the child was handed to a live executor — `SpawnResult.started`. */
  started: Schema.Boolean.pipe(Schema.optional),
  /** Present only when `outcome` is "limit": which quota, and the numbers behind it. */
  reason: Schema.Literals(["depth", "children", "rate"]).pipe(Schema.optional),
  depth: Schema.Finite.pipe(Schema.optional),
  limit: Schema.Finite.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.SpawnResult" })

export const QuestionResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("question-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["answered", "rejected"]),
  answers: Schema.Array(Question.Answer).pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.QuestionResult" })

const ProviderRecoveryWire = Schema.Struct({
  attemptID: Event.ID,
  assistantMessageID: SessionMessage.ID,
  model: Model.Ref,
  startedAt: Schema.Finite,
  toolProtocol: Schema.Boolean,
})
export const ExecutionResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("execution-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["applied", "rejected"]),
  recovery: ProviderRecoveryWire.pipe(Schema.optional),
  error: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.ExecutionResult" })

export const HostMessage = Schema.Union([
  Start,
  Interrupt,
  EventPublished,
  EventRejected,
  DeviceAdmitted,
  DeviceReleased,
  DeviceReported,
  DeviceRejected,
  PermissionResult,
  QuestionResult,
  SpawnResultMessage,
  ColleagueResultMessage,
  AwaitChildResult,
  ExecutionResult,
]).annotate({ identifier: "SessionWorker.HostMessage" })
export type HostMessage = typeof HostMessage.Type

export const Ready = Schema.Struct({
  ...Identity,
  type: Schema.Literal("ready"),
  workerPID: PositiveInt,
}).annotate({ identifier: "SessionWorker.Ready" })

export const Heartbeat = Schema.Struct({
  ...Identity,
  type: Schema.Literal("heartbeat"),
  phase: Schema.Literals(["drain", "provider", "tool", "maintenance"]),
  at: Schema.Finite,
  rssBytes: NonNegativeInt.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.Heartbeat" })

export const Settled = Schema.Struct({
  ...Identity,
  type: Schema.Literal("settled"),
}).annotate({ identifier: "SessionWorker.Settled" })

export const Failed = Schema.Struct({
  ...Identity,
  type: Schema.Literal("failed"),
  classification: Schema.String,
  detail: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.Failed" })

export const PublishEvent = Schema.Struct({
  ...Identity,
  type: Schema.Literal("publish-event"),
  requestID: Schema.String,
  eventType: Schema.String,
  data: Schema.Unknown,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.PublishEvent" })

const DeviceRequestBase = {
  ...Identity,
  requestID: Schema.String,
  deviceKey: Schema.String,
}
export const DeviceAdmit = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-admit"),
  sessionClass: Schema.Literals([
    "interactive",
    "interactive-focused",
    "sub-agent",
    "auto-prompting",
    "goal-oriented",
    "cron",
  ]),
  priority: Schema.Finite.pipe(Schema.optional),
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.optional),
  locality: Schema.Literals(["local", "lan", "remote"]).pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.DeviceAdmit" })
export const DeviceRelease = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-release"),
}).annotate({ identifier: "SessionWorker.DeviceRelease" })
export const DeviceReport = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-report"),
  costTokens: Schema.Finite,
}).annotate({ identifier: "SessionWorker.DeviceReport" })

/**
 * 🔴 **Spawn is a worker→host OPERATION, not an event the worker publishes.**
 *
 * A worker may only publish events for its OWN session — `session-worker/event-bridge.ts` rejects
 * anything else, and its test asserts that. Spawn is the one kernel operation that legitimately
 * concerns two sessions: it creates a child record and admits the child's first input, both carrying
 * an id that is not the worker's. Publishing those from the worker was rejected outright, which left
 * `spawn` dead on the live runner from 2026-08-04 until this message existed.
 *
 * So it takes the shape `permission-assert` already established: the worker ASKS, the host performs
 * the operation under host authority and replies. ⚠️ **`parentID` is deliberately NOT in this payload
 * — the host uses the LEASE's session id.** A worker can therefore spawn children of itself and of
 * nothing else, and that property is structural rather than checked.
 */
/** The payload half of `SpawnChild` — what a worker may ask for. */
export type SpawnChildInput = (typeof SpawnChild.Type)["input"]

/**
 * Join a child session — the second worker→host operation, and the sibling of `SpawnChild`.
 *
 * `tool/wait.ts` awaited a child through `events.durable(...)`, and the worker's `EventV2`
 * replacement dies on the durable stream, so `wait` failed inside every session worker with
 * "only works in host-only contexts". Found the moment fixing spawn let the live smoke reach test 8.
 *
 * ⚠️ **It BLOCKS, which none of the other requests do.** The host tails the child's durable stream
 * until a completion arrives or `timeoutMs` elapses. A timeout is a normal ANSWER (`outcome:
 * "timeout"`), not a transport failure — the child may simply still be working.
 */
export const AwaitChild = Schema.Struct({
  ...Identity,
  type: Schema.Literal("await-child"),
  requestID: Schema.String,
  input: Schema.Struct({ childID: SessionSchema.ID, timeoutMs: Schema.Finite }),
}).annotate({ identifier: "SessionWorker.AwaitChild" })

/**
 * Hand work to a COLLEAGUE — the third worker→host operation, and a sibling of `SpawnChild` for the
 * same reason it exists at all.
 *
 * 🔴 A colleague's chat is not this worker's session, so admitting its input publishes an event
 * carrying an id that is not the lease — which `event-bridge.ts` rejects by design, and correctly: a
 * worker must not be able to write into anyone else's transcript. Measured on a live turn
 * 2026-08-21, before this message existed, the tool came back *"session event does not belong to
 * this worker"*. So the worker ASKS and the host delivers, under host authority.
 *
 * ⚠️ There is no sender field, and that is structural rather than a check: the host stamps the
 * origin from the LEASE, so a worker can speak as itself and as nobody else. The same discipline as
 * `SpawnChild`'s absent `parentID`.
 *
 * ⚠️ It does NOT block. A peer is not a subroutine — the receiver answers in its own chat, in its own
 * time, and a sender that waited would be one half of a deadlock over a question either could have
 * answered alone.
 */
export const ColleagueAsk = Schema.Struct({
  ...Identity,
  type: Schema.Literal("colleague-ask"),
  requestID: Schema.String,
  input: Schema.Struct({
    /** Which colleague, by agent id. The host resolves their chat; the worker never names a session. */
    colleague: Schema.String,
    message: Schema.String,
  }),
}).annotate({ identifier: "SessionWorker.ColleagueAsk" })

export const SpawnChild = Schema.Struct({
  ...Identity,
  type: Schema.Literal("spawn-child"),
  requestID: Schema.String,
  input: Schema.Struct({
    text: Schema.String,
    agent: Schema.String.pipe(Schema.optional),
    model: Model.Ref.pipe(Schema.optional),
    controlBinding: Schema.NonEmptyString.pipe(Schema.optional),
    systemPromptOverride: Schema.String.pipe(Schema.optional),
    type: Schema.Literals(["interactive", "sub-agent", "auto-prompting", "goal-oriented"]).pipe(Schema.optional),
    priority: Schema.Finite.pipe(Schema.optional),
    permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]).pipe(Schema.optional),
  }),
}).annotate({ identifier: "SessionWorker.SpawnChild" })

export const PermissionAssert = Schema.Struct({
  ...Identity,
  type: Schema.Literal("permission-assert"),
  requestID: Schema.String,
  input: Schema.Struct({
    id: Permission.ID.pipe(Schema.optional),
    sessionID: SessionSchema.ID,
    action: Schema.String,
    resources: Schema.Array(Schema.String),
    save: Schema.Array(Schema.String).pipe(Schema.optional),
    metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(Schema.optional),
    source: Permission.Source.pipe(Schema.optional),
    agent: Schema.String.pipe(Schema.optional),
    attachmentPaths: Schema.Array(Schema.String).pipe(Schema.optional),
    targets: Schema.Array(Schema.Struct({ resource: Schema.String, canonical: Schema.String })).pipe(Schema.optional),
  }),
}).annotate({ identifier: "SessionWorker.PermissionAssert" })

export const QuestionAsk = Schema.Struct({
  ...Identity,
  type: Schema.Literal("question-ask"),
  requestID: Schema.String,
  input: Schema.Struct({
    sessionID: SessionSchema.ID,
    questions: Schema.Array(Question.Info),
    tool: Question.Tool.pipe(Schema.optional),
  }),
}).annotate({ identifier: "SessionWorker.QuestionAsk" })

const ExecutionRequestBase = { ...Identity, requestID: Schema.String }
export const ExecutionAdvance = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-advance"),
  phase: Schema.Literals(["drain", "provider", "tool", "maintenance"]),
  checkpoint: Schema.Literals(["clear", "mark", "keep"]),
}).annotate({ identifier: "SessionWorker.ExecutionAdvance" })
export const ExecutionToolDispatched = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-tool-dispatched"),
  callID: Schema.String,
  name: Schema.String,
  sideEffect: Schema.Literals(["read", "idempotent-write", "non-idempotent", "external-unknown"]),
}).annotate({ identifier: "SessionWorker.ExecutionToolDispatched" })
export const ExecutionToolSettled = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-tool-settled"),
  callID: Schema.String,
}).annotate({ identifier: "SessionWorker.ExecutionToolSettled" })
export const ExecutionProviderStarted = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-provider-started"),
  recovery: ProviderRecoveryWire,
}).annotate({ identifier: "SessionWorker.ExecutionProviderStarted" })
export const ExecutionProviderToolProtocol = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-provider-tool-protocol"),
}).annotate({ identifier: "SessionWorker.ExecutionProviderToolProtocol" })
export const ExecutionProviderSettled = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-provider-settled"),
  providerAttemptID: Schema.String,
}).annotate({ identifier: "SessionWorker.ExecutionProviderSettled" })
/**
 * WHICH serving process answered a turn, reported once per distinct identity per attempt.
 *
 * One identity per message rather than the accumulated list: the host owns the accumulation, so
 * a worker cannot shorten a receipt's provenance by sending a list that forgot an entry.
 */
export const ExecutionServedBy = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-served-by"),
  fingerprint: Schema.String,
}).annotate({ identifier: "SessionWorker.ExecutionServedBy" })
export const ExecutionProviderRecovery = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-provider-recovery"),
}).annotate({ identifier: "SessionWorker.ExecutionProviderRecovery" })
export const ExecutionContextUpdated = Schema.Struct({
  ...ExecutionRequestBase,
  type: Schema.Literal("execution-context-updated"),
  messageID: SessionMessage.ID,
  timestamp: Schema.Finite,
  text: Schema.String,
  snapshot: SystemContext.Snapshot,
}).annotate({ identifier: "SessionWorker.ExecutionContextUpdated" })
export type ExecutionRequest =
  | typeof ExecutionAdvance.Type
  | typeof ExecutionToolDispatched.Type
  | typeof ExecutionToolSettled.Type
  | typeof ExecutionProviderStarted.Type
  | typeof ExecutionProviderToolProtocol.Type
  | typeof ExecutionProviderSettled.Type
  | typeof ExecutionProviderRecovery.Type
  | typeof ExecutionServedBy.Type
  | typeof ExecutionContextUpdated.Type

export const WorkerMessage = Schema.Union([
  Ready,
  Heartbeat,
  Settled,
  Failed,
  PublishEvent,
  DeviceAdmit,
  DeviceRelease,
  DeviceReport,
  PermissionAssert,
  SpawnChild,
  ColleagueAsk,
  AwaitChild,
  QuestionAsk,
  ExecutionAdvance,
  ExecutionToolDispatched,
  ExecutionToolSettled,
  ExecutionProviderStarted,
  ExecutionProviderToolProtocol,
  ExecutionProviderSettled,
  ExecutionProviderRecovery,
  ExecutionServedBy,
  ExecutionContextUpdated,
]).annotate({ identifier: "SessionWorker.WorkerMessage" })
export type WorkerMessage = typeof WorkerMessage.Type

export type DecodeResult<A> =
  | { readonly ok: true; readonly message: A }
  | { readonly ok: false; readonly error: string }

const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

const decodeLine = <A>(decode: (input: unknown) => A, line: string): DecodeResult<A> => {
  if (byteLength(line) > MAX_LINE_BYTES) return { ok: false, error: "worker message exceeds the 1 MiB limit" }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return { ok: false, error: "worker message is not valid JSON" }
  }
  try {
    return { ok: true, message: decode(parsed) }
  } catch {
    return { ok: false, error: "worker message does not match protocol version 1" }
  }
}

const decodeHost = Schema.decodeUnknownSync(HostMessage)
const decodeWorker = Schema.decodeUnknownSync(WorkerMessage)

export const decodeHostLine = (line: string): DecodeResult<HostMessage> => decodeLine(decodeHost, line)
export const decodeWorkerLine = (line: string): DecodeResult<WorkerMessage> => decodeLine(decodeWorker, line)
export const encodeLine = (message: HostMessage | WorkerMessage) => `${JSON.stringify(message)}\n`

/** Host-side fencing gate. Decode proves shape; this proves that a message still belongs to the
 * current owner. A late worker is rejected before its event can reach the database or SSE bridge. */
export function owns(lease: SessionExecutionAttempt.Lease, message: HostMessage | WorkerMessage): boolean {
  return (
    message.sessionID === lease.sessionID &&
    message.attemptID === lease.attemptID &&
    message.generation === lease.generation
  )
}
