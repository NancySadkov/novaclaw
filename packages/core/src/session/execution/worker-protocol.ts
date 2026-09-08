export * as SessionWorkerProtocol from "./worker-protocol"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../../schema"
import { SessionSchema } from "../schema"
import type { SessionExecutionAttempt } from "../execution-attempt"
import { EventV2 } from "../../event"
import { Permission } from "@novaclaw/schema/permission"
import { Event } from "@novaclaw/schema/event"
import { Model } from "@novaclaw/schema/model"
import { SessionMessage } from "@novaclaw/schema/session-message"
import { SystemContext } from "../../system-context/index"
import { Location } from "../../location"

export const VERSION = 1 as const
// Large enough for the base64 envelope of the read tool's 20 MiB media-ingest ceiling in both the
// structured result and its model-facing file part. The process transport separately chunks this
// logical message into bounded physical frames.
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024

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
export const DeviceMaintenanceAdmitted = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-maintenance-admitted"),
  maintenanceID: Schema.String,
}).annotate({ identifier: "SessionWorker.DeviceMaintenanceAdmitted" })
export const DeviceMaintenanceReleased = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-maintenance-released"),
}).annotate({ identifier: "SessionWorker.DeviceMaintenanceReleased" })
export const DeviceMaintenancePreempted = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-maintenance-preempted"),
}).annotate({ identifier: "SessionWorker.DeviceMaintenancePreempted" })
export const DeviceRejected = Schema.Struct({
  ...DeviceReplyBase,
  type: Schema.Literal("device-rejected"),
  error: Schema.String,
}).annotate({ identifier: "SessionWorker.DeviceRejected" })

export const PermissionResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("permission-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["allowed", "denied", "rejected", "session-missing"]),
  rules: Permission.Ruleset.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
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
 * The outcomes are different facts and are deliberately not flattened: `delivered` means it landed in
 * their chat, `no-chat` means that colleague has no open conversation to leave it in (the model must
 * say so rather than retry), `refused` means the loop bound stopped it, and `rejected` means the
 * request never got that far — a stale lease. Collapsing them would tell a model to retry a thing
 * that cannot succeed.
 *
 * ⚠️ **`refused` carries its `reason` ACROSS the worker boundary, and that is the point.** The tool
 * runs inside the worker and never sees the host's `Delivery` object — it sees this message. A bound
 * whose explanation stopped at the bridge would be a mechanism the model is never told about: it
 * would read "no open chat", go on trying to reach a colleague it was just stopped from reaching, and
 * the cap would look broken from every side that matters.
 */
export const ColleagueResultMessage = Schema.Struct({
  ...Identity,
  type: Schema.Literal("colleague-result"),
  requestID: Schema.String,
  outcome: Schema.Literals([
    "delivered",
    "group-delivered",
    "no-chat",
    "refused",
    "hired",
    "retired",
    "organized",
    "organization-refused",
    "rejected",
  ]),
  /** Why the loop bound refused; present only when `outcome` is "refused". Read by the sender. */
  reason: Schema.String.pipe(Schema.optional),
  /** Whether anything is actually running their chat — `false` means durable but dormant. */
  started: Schema.Boolean.pipe(Schema.optional),
  /**
   * Who a GROUP message actually reached, and who it could not — present only for "group-delivered".
   *
   * ⚠️ Both halves cross the boundary for the same reason `reason` does: the tool runs inside the
   * worker and never sees the host's `GroupDelivery`. A sender told only "delivered" would believe it
   * had assembled the room it named, and the colleagues it never reached would simply be missing from
   * a conversation nobody knows is incomplete.
   */
  delivered: Schema.Array(Schema.String).pipe(Schema.optional),
  missing: Schema.Array(Schema.String).pipe(Schema.optional),
  /** The shared id every copy carries, so a reply can address the set. */
  conversation: Schema.String.pipe(Schema.optional),
  /** The new colleague's id and display name; present only when `outcome` is "hired". */
  hiredID: Schema.String.pipe(Schema.optional),
  hiredName: Schema.String.pipe(Schema.optional),
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
  // ⚠️ MUST match `SessionSpawner.SpawnLimitError.reason`. This is the fourth link the reason travels
  // (guard -> error -> worker protocol -> host handler), and the typechecker is the only thing that
  // notices when one of them is left behind: adding `pressure` on the kernel side alone made the
  // WORKER boundary reject it, which surfaced as an unrelated-looking handler-signature error in
  // `session-worker/execution.ts`.
  reason: Schema.Literals(["depth", "children", "rate", "pressure"]).pipe(Schema.optional),
  depth: Schema.Finite.pipe(Schema.optional),
  limit: Schema.Finite.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.SpawnResult" })

/**
 * The host's answer to a `memory-request`.
 *
 * `ok` carries the op's own return value; `failed` is the store's own `MemoryClient.MemoryError`
 * rebuilt on the worker side, so a caller degrades exactly as it would in-process; `rejected` means
 * the request never reached the store — a stale lease, a malformed access, or a result too large for
 * the transport.
 *
 * ⚠️ **`rejected` is NOT flattened into `failed`.** A store that answered "I could not do that" and a
 * boundary that refused to ask are different facts, and the second one is a defect in us.
 */
export const MemoryResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("memory-result"),
  /** Which host-owned graph answered; the worker has two memory capabilities. */
  store: Schema.Literals(["kb", "world"]),
  requestID: Schema.String,
  outcome: Schema.Literals(["ok", "failed", "rejected"]),
  /** The op's return value, already JSON. Absent for `void` returns and for every non-ok outcome. */
  value: Schema.Unknown.pipe(Schema.optional),
  /** Why it failed or was refused. Becomes `MemoryError.reason` on the worker side. */
  reason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.MemoryResult" })

export const LocalModelResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("local-model-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["ok", "failed", "rejected"]),
  /** Absent: `ensure` returns nothing. Kept so a future op with a value needs no new message. */
  value: Schema.Unknown.pipe(Schema.optional),
  /** Why it failed or was refused. Becomes `LocalModelManager.UnavailableError.message` on the worker. */
  reason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.LocalModelResult" })

export const DriveStateResult = Schema.Struct({
  ...Identity,
  type: Schema.Literal("drive-state-result"),
  requestID: Schema.String,
  outcome: Schema.Literals(["ok", "failed", "rejected"]),
  /** `load` answers the session's `SessionDriveState.Snapshot`, already JSON; `save` answers nothing. */
  value: Schema.Unknown.pipe(Schema.optional),
  reason: Schema.String.pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.DriveStateResult" })

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
  DeviceMaintenanceAdmitted,
  DeviceMaintenanceReleased,
  DeviceMaintenancePreempted,
  DeviceRejected,
  PermissionResult,
  MemoryResult,
  LocalModelResult,
  DriveStateResult,
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
export const DeviceMaintenanceAdmit = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-maintenance-admit"),
  task: Schema.String,
  concurrency: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(Schema.optional),
  locality: Schema.Literals(["local", "lan", "remote"]).pipe(Schema.optional),
}).annotate({ identifier: "SessionWorker.DeviceMaintenanceAdmit" })
export const DeviceMaintenanceRelease = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-maintenance-release"),
  maintenanceID: Schema.String,
}).annotate({ identifier: "SessionWorker.DeviceMaintenanceRelease" })
export const DeviceMaintenanceAwaitPreemption = Schema.Struct({
  ...DeviceRequestBase,
  type: Schema.Literal("device-maintenance-await-preemption"),
  maintenanceID: Schema.String,
}).annotate({ identifier: "SessionWorker.DeviceMaintenanceAwaitPreemption" })

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
/** The payload half of `ColleagueRequest` — ask a colleague, or staff the organization. */
export type ColleagueRequestInput = (typeof ColleagueRequest.Type)["input"]

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
 * Colleague operations — the third worker→host channel, and a sibling of `SpawnChild` for the
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
export const ColleagueRequest = Schema.Struct({
  ...Identity,
  type: Schema.Literal("colleague-request"),
  requestID: Schema.String,
  input: Schema.Union([
    Schema.Struct({
      op: Schema.Literal("ask"),
      /** Which colleague, by agent id. The host resolves their chat; the worker never names a session. */
      colleague: Schema.String,
      message: Schema.String,
    }),
    /** Staffing the organization. Whether the SENDER may do this is the org chart's business
     *  (`tool/colleague.ts` → `mayStaff`) and the permission evaluator's; the host's business is that
     *  the write lands and the live roster is re-materialised, which is why it cannot happen in the
     *  worker — measured: a worker-side hire left the colleague durable and invisible. */
    Schema.Struct({
      op: Schema.Literal("hire"),
      title: Schema.String,
      brief: Schema.String,
      personality: Schema.String.pipe(Schema.optional),
    }),
    Schema.Struct({ op: Schema.Literal("retire"), colleague: Schema.String }),
    Schema.Struct({ op: Schema.Literal("set_superior"), colleague: Schema.String, superior: Schema.String }),
    /**
     * Put ONE message to SEVERAL colleagues, as one conversation.
     *
     * A separate op rather than `ask` with a list: the two charge the loop bound differently (once
     * per recipient, not once per call), and a single field meaning either would make the difference
     * invisible at the call site where it is being decided.
     */
    Schema.Struct({
      op: Schema.Literal("ask_group"),
      colleagues: Schema.Array(Schema.String),
      message: Schema.String,
    }),
  ]),
}).annotate({ identifier: "SessionWorker.ColleagueRequest" })

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

/**
 * 🔴 **THE GRAPH HAS ONE WRITER, AND THIS IS HOW A WORKER REACHES IT.**
 *
 * `kb-graph/memory.ts`'s header has always claimed *one engine per instance = the single writer*.
 * It was not true: `session-worker/services.ts` swapped seven host-owned services for proxying stubs
 * and not this one, so a worker built a SECOND WASM engine on the same graph directory. The host's
 * engine is lazy, so the two only coexisted when something host-side touched memory during a live
 * turn — which is exactly what the Memory app does. Generation snapshots made that worse rather than
 * merely redundant: `publish()` picks `max(existing) + 1`, so two writers can compute the same index
 * and clobber each other, and each prunes to KEEP=2 knowing nothing about the other's generations.
 *
 * So memory joins `permission-assert`, `spawn-child`, `colleague-request` and `await-child` as a
 * worker→host OPERATION. One writer by construction, not by a rule somebody has to remember.
 *
 * ⚠️ **The op vocabulary is CLOSED and mirrors `MemoryClient.Interface` exactly.** A missing arm is a
 * compile error on the host bridge's exhaustive switch, which is the only thing that stops this
 * message from quietly growing a hole the day the interface grows a method.
 *
 * ⚠️ **`args` rides as `Unknown`, like `publish-event`'s `data`** — the payloads are the store's own
 * plain shapes and re-declaring twenty-two of them as schemas would be a second, drifting copy of
 * `memory-client.ts`. The one argument the bridge DOES decode is `MemoryAccess`, because there
 * `undefined` means *every scope* and a field lost in transit would silently widen the caller's
 * reach — the exact mechanism NC-SEC-016 was.
 *
 * ⚠️ **This does not make the worker less privileged than it was.** It ran the real engine with no
 * restriction at all; proxying is strictly not-worse, and the boundary is about WHO WRITES, not about
 * confining what the worker may ask for. Saying otherwise would promise a gate this is not.
 */
export const MEMORY_OPS = [
  "health",
  "addMemory",
  "addEdge",
  "search",
  "neighbors",
  "get",
  "path",
  "invalidate",
  "purge",
  "addClaim",
  "claimHistory",
  "reviewEvidence",
  "setClaimStatus",
  "moveScope",
  "clearScope",
  "eraseAll",
  "discardLegacyGlobalExtracts",
  "stats",
  "list",
  "candidates",
  "byIds",
  "graph",
] as const
export type MemoryOp = (typeof MEMORY_OPS)[number]

export const MemoryRequest = Schema.Struct({
  ...Identity,
  type: Schema.Literal("memory-request"),
  /** Explicit/source KB versus automatic session/agent world model. */
  store: Schema.Literals(["kb", "world"]),
  requestID: Schema.String,
  op: Schema.Literals(MEMORY_OPS),
  /** The op's arguments, positionally, exactly as `MemoryClient.Interface` declares them. */
  args: Schema.Array(Schema.Unknown),
}).annotate({ identifier: "SessionWorker.MemoryRequest" })

/**
 * The managed local model (the llama.cpp child on its fixed port) is HOST-ONLY, and `ensure` is the
 * one thing a worker may ask of it: "be running for this model". Deliberately not `status`,
 * `install` or `stop` — nothing in a worker calls them, and authority narrows downward: a session
 * process must not be able to stop the engine every other session is served by.
 */
export const LOCAL_MODEL_OPS = ["ensure"] as const
export type LocalModelOp = (typeof LOCAL_MODEL_OPS)[number]

export const LocalModelRequest = Schema.Struct({
  ...Identity,
  type: Schema.Literal("local-model-request"),
  requestID: Schema.String,
  op: Schema.Literals(LOCAL_MODEL_OPS),
  /** The op's arguments, positionally, exactly as `LocalModelManager.Interface` declares them. */
  args: Schema.Array(Schema.Unknown),
}).annotate({ identifier: "SessionWorker.LocalModelRequest" })

/**
 * The runner's cross-drain controller facts (`core/session/runner/drive-state.ts`) live in the
 * HOST, because the host is the one process that outlives a drain. A worker hydrates its per-drain
 * caches with `load` when its run starts and writes them back with `save` on every mutation.
 */
export const DRIVE_STATE_OPS = ["load", "save"] as const
export type DriveStateOp = (typeof DRIVE_STATE_OPS)[number]

export const DriveStateRequest = Schema.Struct({
  ...Identity,
  type: Schema.Literal("drive-state-request"),
  requestID: Schema.String,
  op: Schema.Literals(DRIVE_STATE_OPS),
  /** `load`: `[]`. `save`: `[snapshot]`, the whole `SessionDriveState.Snapshot`. */
  args: Schema.Array(Schema.Unknown),
}).annotate({ identifier: "SessionWorker.DriveStateRequest" })

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
  DeviceMaintenanceAdmit,
  DeviceMaintenanceRelease,
  DeviceMaintenanceAwaitPreemption,
  PermissionAssert,
  MemoryRequest,
  LocalModelRequest,
  DriveStateRequest,
  SpawnChild,
  ColleagueRequest,
  AwaitChild,
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

/**
 * THE logical message size, in the unit `decodeLine` enforces.
 *
 * 🔴 Exported because every guard whose job is to keep an oversized line away from that decoder must
 * compute THIS number. A guard using `String.length` — UTF-16 code units — against a byte budget is
 * up to 3x too permissive (2x for Cyrillic or astral emoji, 3x for CJK), which is how a non-ASCII
 * memory result killed a session worker instead of failing one call. Keeping the measure private
 * meant every caller re-derived it, and one re-derived it wrong.
 */
export const byteLength = (value: string) => new TextEncoder().encode(value).byteLength

const decodeLine = <A>(decode: (input: unknown) => A, line: string): DecodeResult<A> => {
  if (byteLength(line) > MAX_MESSAGE_BYTES) return { ok: false, error: "worker message exceeds the 64 MiB limit" }
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
