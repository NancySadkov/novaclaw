export * as SessionMessage from "./session-message"

import { Schema } from "effect"
import { optional } from "./schema"
import { ProviderMetadata, ToolContent } from "./llm"
import { Model } from "./model"
import { FileAttachment, Prompt } from "./prompt"
import { DateTimeUtcFromMillis, NonNegativeInt, PositiveInt, RelativePath, statics } from "./schema"
import { SessionID } from "./session-id"
import { ascending } from "./identifier"

export const ID = Schema.String.check(Schema.isStartsWith("msg_")).pipe(
  Schema.brand("Session.Message.ID"),
  statics((schema) => ({ create: () => schema.make("msg_" + ascending()) })),
)
export type ID = typeof ID.Type

/**
 * The taxonomy of a session fault, as it travels the wire.
 *
 * Eleven arms mirror `LLMErrorReason` (`packages/llm/src/schema/errors.ts`) one-for-one; the last
 * two are faults the session runner raises itself rather than receiving from a provider. This
 * tuple is the CLOSED vocabulary — every member needs display code and an i18n key, so
 * ruling 10's "a thing needing new code stays a closed compiled set" applies to the *set*, and
 * `sessionErrorArms` in `@novaclaw/core/session/session-error` is pinned against it by test.
 *
 * ⚠️ The wire FIELD is deliberately `Schema.String`, not `Schema.Literals(ErrorTags)`. A closed
 * literal there would make a row written by a newer instance — or replayed from a P2P peer one
 * version ahead — fail decode *as a whole event*, losing the message too. That is strictly worse
 * than an unrecognised tag, which every reader must already fall back on (see `UnknownError`).
 */
export const ErrorTags = [
  "InvalidRequest",
  "NoRoute",
  "Authentication",
  "RateLimit",
  "QuotaExceeded",
  "ContentPolicy",
  "ProviderInternal",
  "Transport",
  // A request this instance REFUSED to make (offline/airgap mode). Deliberately not `Transport`:
  // a policy decision and an outage are different faults, and one tag for both made a retry
  // affordance appear on something no retry can fix. See `LLM.Error.OfflineBlocked`.
  "OfflineBlocked",
  "InvalidProviderOutput",
  "UnknownProvider",
  // Raised by the runner, not by a provider.
  "Interrupted",
  "ToolFailure",
] as const
export type ErrorTag = (typeof ErrorTags)[number]

/**
 * A session fault as the transcript, the CLI and any other reader see it.
 *
 * `message` is the ONE required field and stays the raw, honest text — it is what a model reads
 * back on the next turn (`toLLMMessages` replays it as "[Previous turn failed …]"), so it must
 * keep the diagnostic detail. `_tag` and `retryable` are ADDITIONAL structure, never a
 * replacement: they let a display surface pick a translated sentence and decide whether to offer
 * "retry" instead of pasting transport noise into a conversation.
 *
 * **Both are optional, and that is load-bearing.** Every session record persisted before this
 * field existed holds `{ type:"unknown", message }`; it decodes unchanged, and a reader that
 * treats an absent tag as "unknown fault, use the message" renders it exactly as it did before.
 * That is why this is NOT a durable-manifest version bump: `Event.durable` keys rows by
 * `type.version`, so bumping would fork the manifest and — if the old definition were ever
 * dropped — retire every old row (`event.test.ts`: "skips durable rows whose type has been
 * retired from the manifest"). An added optional field is backward *and* forward compatible
 * under the same version.
 *
 * `retryable` means "retrying this same turn can plausibly succeed", which is the USER's
 * question, not the schema-level `LLMErrorReason.retryable` getter — those two disagree on
 * `Transport` on purpose (see `session/runner/provider-retry.ts`: a local vLLM that is down or
 * restarting is the common case and IS worth retrying). A producer must fill this from the
 * runner's `ProviderRetry.isTransientProviderFailure` verdict, not from `LLMError.retryable`.
 * `status` preserves an HTTP verdict such as Cloudflare 524 so the UI can explain the actual
 * failure rather than collapsing every upstream gateway timeout into "internal error".
 */
export interface UnknownError extends Schema.Schema.Type<typeof UnknownError> {}
export const UnknownError = Schema.Struct({
  type: Schema.Literal("unknown"),
  message: Schema.String,
  _tag: Schema.String.pipe(optional),
  retryable: Schema.Boolean.pipe(optional),
  status: PositiveInt.pipe(optional),
}).annotate({ identifier: "Session.Error.Unknown" })

const Base = {
  id: ID,
  metadata: Schema.Record(Schema.String, Schema.Unknown).pipe(optional),
  time: Schema.Struct({ created: DateTimeUtcFromMillis }),
}

export interface AgentSwitched extends Schema.Schema.Type<typeof AgentSwitched> {}
export const AgentSwitched = Schema.Struct({
  ...Base,
  type: Schema.Literal("agent-switched"),
  agent: Schema.String,
}).annotate({ identifier: "Session.Message.AgentSwitched" })

export interface ModelSwitched extends Schema.Schema.Type<typeof ModelSwitched> {}
export const ModelSwitched = Schema.Struct({
  ...Base,
  type: Schema.Literal("model-switched"),
  model: Model.Ref,
}).annotate({ identifier: "Session.Message.ModelSwitched" })

export interface User extends Schema.Schema.Type<typeof User> {}
export const User = Schema.Struct({
  ...Base,
  text: Prompt.fields.text,
  files: Prompt.fields.files,
  agents: Prompt.fields.agents,
  // Provenance (P6) — carried onto the message record so lowering renders the model header and the
  // UI renders a sender badge. Absent = the local human.
  origin: Prompt.fields.origin,
  type: Schema.Literal("user"),
}).annotate({ identifier: "Session.Message.User" })

export interface Synthetic extends Schema.Schema.Type<typeof Synthetic> {}
export const Synthetic = Schema.Struct({
  ...Base,
  sessionID: SessionID,
  text: Schema.String,
  type: Schema.Literal("synthetic"),
}).annotate({ identifier: "Session.Message.Synthetic" })

export interface System extends Schema.Schema.Type<typeof System> {}
export const System = Schema.Struct({
  ...Base,
  type: Schema.Literal("system"),
  text: Schema.String,
}).annotate({ identifier: "Session.Message.System" })

export interface Shell extends Schema.Schema.Type<typeof Shell> {}
export const Shell = Schema.Struct({
  ...Base,
  type: Schema.Literal("shell"),
  callID: Schema.String,
  command: Schema.String,
  output: Schema.String,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Shell" })

export interface ToolStatePending extends Schema.Schema.Type<typeof ToolStatePending> {}
export const ToolStatePending = Schema.Struct({
  status: Schema.Literal("pending"),
  input: Schema.String,
}).annotate({ identifier: "Session.Message.ToolState.Pending" })

export interface ToolStateRunning extends Schema.Schema.Type<typeof ToolStateRunning> {}
export const ToolStateRunning = Schema.Struct({
  status: Schema.Literal("running"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
}).annotate({ identifier: "Session.Message.ToolState.Running" })

export interface ToolStateCompleted extends Schema.Schema.Type<typeof ToolStateCompleted> {}
export const ToolStateCompleted = Schema.Struct({
  status: Schema.Literal("completed"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  attachments: FileAttachment.pipe(Schema.Array, optional),
  content: ToolContent.pipe(Schema.Array),
  outputPaths: Schema.Array(Schema.String).pipe(optional),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Completed" })

export interface ToolStateError extends Schema.Schema.Type<typeof ToolStateError> {}
export const ToolStateError = Schema.Struct({
  status: Schema.Literal("error"),
  input: Schema.Record(Schema.String, Schema.Unknown),
  content: ToolContent.pipe(Schema.Array),
  structured: Schema.Record(Schema.String, Schema.Unknown),
  error: UnknownError,
  result: Schema.Unknown.pipe(optional),
}).annotate({ identifier: "Session.Message.ToolState.Error" })

export const ToolState = Schema.Union([ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError]).pipe(
  Schema.toTaggedUnion("status"),
)
export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError

export interface AssistantTool extends Schema.Schema.Type<typeof AssistantTool> {}
export const AssistantTool = Schema.Struct({
  type: Schema.Literal("tool"),
  id: Schema.String,
  name: Schema.String,
  provider: Schema.Struct({
    executed: Schema.Boolean,
    metadata: ProviderMetadata.pipe(optional),
    resultMetadata: ProviderMetadata.pipe(optional),
  }).pipe(optional),
  state: ToolState,
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    ran: DateTimeUtcFromMillis.pipe(optional),
    completed: DateTimeUtcFromMillis.pipe(optional),
    pruned: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant.Tool" })

export interface AssistantText extends Schema.Schema.Type<typeof AssistantText> {}
export const AssistantText = Schema.Struct({
  type: Schema.Literal("text"),
  id: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "Session.Message.Assistant.Text" })

export interface AssistantReasoning extends Schema.Schema.Type<typeof AssistantReasoning> {}
export const AssistantReasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.String,
  text: Schema.String,
  providerMetadata: ProviderMetadata.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }).pipe(optional),
}).annotate({ identifier: "Session.Message.Assistant.Reasoning" })

export const AssistantContent = Schema.Union([AssistantText, AssistantReasoning, AssistantTool]).pipe(
  Schema.toTaggedUnion("type"),
)
export type AssistantContent = AssistantText | AssistantReasoning | AssistantTool

export const ContextFinding = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("duplicate-tool-output"),
    tool: Schema.String,
    target: Schema.String.pipe(optional),
    occurrences: PositiveInt,
    repeatedTokens: NonNegativeInt,
    elided: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("dominant-tool-output"),
    tool: Schema.String,
    target: Schema.String.pipe(optional),
    tokens: NonNegativeInt,
    percent: Schema.Finite,
  }),
  Schema.Struct({
    kind: Schema.Literal("category-budget"),
    category: Schema.Literals(["system", "messages", "retrieval", "memory", "tool_output"]),
    limitTokens: NonNegativeInt,
    beforeTokens: NonNegativeInt,
    afterTokens: NonNegativeInt,
    affectedMessages: NonNegativeInt,
    protected: Schema.Boolean,
  }),
]).pipe(Schema.toTaggedUnion("kind"))
export type ContextFinding = typeof ContextFinding.Type

/** What the deterministic packer put on one provider turn's wire. Optional on old rows and on
 *  Strict turns, whose separate engine does not currently pass through the native packer. */
export interface Context extends Schema.Schema.Type<typeof Context> {}
export const Context = Schema.Struct({
  window: PositiveInt,
  estimatedTokens: NonNegativeInt,
  droppedMessages: NonNegativeInt,
  elidedOutputs: NonNegativeInt,
  findings: Schema.Array(ContextFinding),
}).annotate({ identifier: "Session.Message.Context" })

export interface Assistant extends Schema.Schema.Type<typeof Assistant> {}
export const Assistant = Schema.Struct({
  ...Base,
  type: Schema.Literal("assistant"),
  agent: Schema.String,
  model: Model.Ref,
  content: AssistantContent.pipe(Schema.Array),
  snapshot: Schema.Struct({
    start: Schema.String.pipe(optional),
    end: Schema.String.pipe(optional),
    files: Schema.Array(RelativePath).pipe(optional),
  }).pipe(optional),
  finish: Schema.String.pipe(optional),
  cost: Schema.Finite.pipe(optional),
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({ read: Schema.Finite, write: Schema.Finite }),
  }).pipe(optional),
  context: Context.pipe(optional),
  error: UnknownError.pipe(optional),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    completed: DateTimeUtcFromMillis.pipe(optional),
  }),
}).annotate({ identifier: "Session.Message.Assistant" })

export interface Compaction extends Schema.Schema.Type<typeof Compaction> {}
export const Compaction = Schema.Struct({
  type: Schema.Literal("compaction"),
  reason: Schema.Literals(["auto", "manual"]),
  summary: Schema.String,
  recent: Schema.String,
  ...Base,
}).annotate({ identifier: "Session.Message.Compaction" })

export const Message = Schema.Union([
  AgentSwitched,
  ModelSwitched,
  User,
  Synthetic,
  System,
  Shell,
  Assistant,
  Compaction,
])
  .pipe(Schema.toTaggedUnion("type"))
  .annotate({ identifier: "Session.Message" })
export type Message = AgentSwitched | ModelSwitched | User | Synthetic | System | Shell | Assistant | Compaction
export type Type = Message["type"]
