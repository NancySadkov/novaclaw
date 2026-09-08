export * as SessionEvent from "./session-event"

import { Schema } from "effect"
import { optional } from "./schema"
import { Event } from "./event"
import { ProviderMetadata, ToolContent } from "./llm"
import { Delivery } from "./session-delivery"
import { Model } from "./model"
import { DateTimeUtcFromMillis, NonNegativeInt, RelativePath } from "./schema"
import { FileAttachment, Prompt } from "./prompt"
import { SessionFeature } from "./session-feature"
import { SessionID } from "./session-id"
import { SessionStrict } from "./session-strict"
import { SessionType } from "./session-type"
import { Location } from "./location"
import { SessionMessage } from "./session-message"
import { Revert } from "./revert"
import { SessionProviderRecovery } from "./session-provider-recovery"

export { FileAttachment }

export const Source = Schema.Struct({
  start: NonNegativeInt,
  end: NonNegativeInt,
  text: Schema.String,
}).annotate({
  identifier: "session.next.event.source",
})
export interface Source extends Schema.Schema.Type<typeof Source> {}

const Base = {
  timestamp: DateTimeUtcFromMillis,
  sessionID: SessionID,
}
const PromptFields = {
  ...Base,
  messageID: SessionMessage.ID,
  prompt: Prompt,
  delivery: Delivery,
}

const options = {
  durable: {
    aggregate: "sessionID",
    version: 1,
  },
} as const
const stepSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    version: 2,
  },
} as const
const compactionSettlementOptions = {
  durable: {
    aggregate: "sessionID",
    // v2 adds the exact canonical-prefix identity. v1 summaries are deliberately skipped on
    // replay because they cannot prove which transcript they cover.
    version: 2,
  },
} as const

export const UnknownError = SessionMessage.UnknownError
export type UnknownError = SessionMessage.UnknownError

// ⚠️ `null` CLEARS the override back to inherit (parent chain, then the instance default) — the
// same idiom `StrictSwitched` and `FeatureSwitched` already use. Widening these four was the ECS
// lens applied to its own kernel: `resolveSessionConfig` treats `undefined` as inherit, so a
// component that can only ever be SET is a sparse-override column with no way back to sparse.
// The session columns were nullable all along; only the event vocabulary was missing.
export const AgentSwitched = Event.define({
  type: "session.next.agent.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    agent: Schema.NullOr(Schema.String),
  },
})
export type AgentSwitched = typeof AgentSwitched.Type

export const ModelSwitched = Event.define({
  type: "session.next.model.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    model: Schema.NullOr(Model.Ref),
  },
})
export type ModelSwitched = typeof ModelSwitched.Type

// B10: live control handoff — who responds on OUR side of the conversation. "nova" =
// the AI answers (default); "operator" = a human has taken control, so the runner stops
// auto-responding (the user is an agent whose CPU is a human — the Vision made concrete).
export const ResponderSwitched = Event.define({
  type: "session.next.responder.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    responder: Schema.NullOr(Schema.Literals(["nova", "operator"])),
  },
})
export type ResponderSwitched = typeof ResponderSwitched.Type

// 1K: mid-session permission-mode switch (the MODE_RULES overlay is read fresh each turn, so
// flipping the column takes effect on the next turn without restarting the session).
export const ModeSwitched = Event.define({
  type: "session.next.mode.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]),
  },
})
export type ModeSwitched = typeof ModeSwitched.Type

// Auto mode's model-authored move. Unlike ModeSwitched this does not change the user's ceiling;
// its event is projected into a transcript card while the atomic commit writes session_auto_grant.
export const PermissionChanged = Event.define({
  type: "session.next.permission.changed",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    op: Schema.Literals(["raise", "lower"]),
    previous: SessionMessage.PermissionMode,
    mode: SessionMessage.PermissionMode,
    ceiling: SessionMessage.PermissionMode,
    justification: Schema.NonEmptyString,
  },
})
export type PermissionChanged = typeof PermissionChanged.Type

// The per-session Strict-harness override switch (the composer's Strict toggle — jh.md). Like
// ModeSwitched, the runner reads the projected column fresh each turn. `strict: null` clears the
// override back to inherit (parent chain, then global config).
export const StrictSwitched = Event.define({
  type: "session.next.strict.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    strict: Schema.NullOr(SessionStrict.Override),
  },
})
export type StrictSwitched = typeof StrictSwitched.Type

// The per-session harness-feature toggles (the composer's Tuning control — introspection ·
// quality · affective). Like StrictSwitched, the runner reads the projected column fresh each
// turn. `enabled: null` clears the override back to inherit (parent chain, then global config).
export const FeatureSwitched = Event.define({
  type: "session.next.feature.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    feature: SessionFeature.Name,
    enabled: Schema.NullOr(Schema.Boolean),
  },
})
export type FeatureSwitched = typeof FeatureSwitched.Type

// The chat's kernel thread type (the composer's Mode control — architecture.md typed threads).
// Attendance derives from the chain ROOT's type (agent-jail doctrine), so switching a root chat
// to an unattended type is the "keep working without me" flag: out-of-folder writes are DENIED rather
// than asked (nobody is there to answer), bash runs
// confined (or is denied without a jail backend), affective nudges engage, and the EEVDF
// scheduler reweights. The projector writes the column; consumers (rootSessionType, the
// scheduler) read session rows fresh, so the flip applies immediately.
export const TypeSwitched = Event.define({
  type: "session.next.type.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    sessionType: Schema.NullOr(SessionType.Info),
  },
})
export type TypeSwitched = typeof TypeSwitched.Type

// B4/T2: the per-session system-prompt OVERRIDE layer (the info-sheet editor + the agent's own
// guardrailed `session` tool). The override composes after the persona baseline and before the
// agent prompt (runner llm.ts system assembly) and rides the config walk (children/forks inherit).
// `override: null` clears the layer. Like the switches above, the projector writes the column and
// the runner reads it fresh each turn.
export const PromptOverrideSwitched = Event.define({
  type: "session.next.prompt-override.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    override: Schema.NullOr(Schema.String),
  },
})
export type PromptOverrideSwitched = typeof PromptOverrideSwitched.Type

export const DeviceSwitched = Event.define({
  type: "session.next.device.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    device: Schema.NullOr(Schema.String),
  },
})
export type DeviceSwitched = typeof DeviceSwitched.Type

export const PrioritySwitched = Event.define({
  type: "session.next.priority.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    priority: Schema.NullOr(Schema.Finite),
  },
})
export type PrioritySwitched = typeof PrioritySwitched.Type

// The session's explicit computer substrate. `null` clears the sparse override so the parent
// chain, then the instance's `computer.display`, becomes effective again on the next tool call.
export const ControlBindingSwitched = Event.define({
  type: "session.next.control-binding.switched",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    controlBinding: Schema.NullOr(Schema.NonEmptyString),
  },
})
export type ControlBindingSwitched = typeof ControlBindingSwitched.Type

export const Moved = Event.define({
  type: "session.next.moved",
  ...options,
  schema: {
    ...Base,
    location: Location.Ref,
    subdirectory: RelativePath.pipe(optional),
  },
})
export type Moved = typeof Moved.Type

// Agent-OS lifecycle (architecture.md step 5): a session's `exit(result)` — the complement to spawn.
// Durable so `wait(childID)` can observe it after the fact; the projector writes `result` to the
// session row (for ps/list). The projected `result` is also the self-drive terminal test: an
// auto-prompting/goal-oriented drain keeps re-prompting itself until it lands (runner/drive.ts).
export const Completed = Event.define({
  type: "session.next.completed",
  ...options,
  schema: {
    ...Base,
    result: Schema.Unknown.pipe(optional),
  },
})
export type Completed = typeof Completed.Type

export const Prompted = Event.define({
  type: "session.next.prompted",
  ...options,
  schema: PromptFields,
})
export type Prompted = typeof Prompted.Type

export const PromptAdmitted = Event.define({
  type: "session.next.prompt.admitted",
  ...options,
  schema: PromptFields,
})
export type PromptAdmitted = typeof PromptAdmitted.Type

export const ContextUpdated = Event.define({
  type: "session.next.context.updated",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
  },
})
export type ContextUpdated = typeof ContextUpdated.Type

export const Synthetic = Event.define({
  type: "session.next.synthetic",
  ...options,
  schema: {
    ...Base,
    messageID: SessionMessage.ID,
    text: Schema.String,
    repair: SessionMessage.SyntheticRepair.pipe(optional),
  },
})
export type Synthetic = typeof Synthetic.Type

export namespace ProviderAttempt {
  export const Started = Event.define({
    type: "session.next.provider-attempt.started",
    ...options,
    schema: {
      ...Base,
      recovery: SessionProviderRecovery.Info,
    },
  })
  export type Started = typeof Started.Type

  export const Settled = Event.define({
    type: "session.next.provider-attempt.settled",
    ...options,
    schema: {
      ...Base,
      attemptID: Event.ID,
      outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    },
  })
  export type Settled = typeof Settled.Type

  export const Abandoned = Event.define({
    type: "session.next.provider-attempt.abandoned",
    ...options,
    schema: {
      ...Base,
      attemptID: Event.ID,
      reason: Schema.Literal("new-input"),
    },
  })
  export type Abandoned = typeof Abandoned.Type
}

// F1c fork: one full projected message RECORDED into a session's transcript as a single
// durable event — how a fork copies the source transcript prefix into the NEW aggregate.
// Self-contained (the whole message rides the event), so replaying a forked session
// rebuilds its transcript without reaching into the source aggregate.
export const MessageRecorded = Event.define({
  type: "session.next.message.recorded",
  ...options,
  schema: {
    ...Base,
    message: SessionMessage.Message,
  },
})
export type MessageRecorded = typeof MessageRecorded.Type

export namespace Shell {
  export const Started = Event.define({
    type: "session.next.shell.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      callID: Schema.String,
      command: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.shell.ended",
    ...options,
    schema: {
      ...Base,
      callID: Schema.String,
      output: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Step {
  export const Started = Event.define({
    type: "session.next.step.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      agent: Schema.String,
      model: Model.Ref,
      snapshot: Schema.String.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  export const Ended = Event.define({
    type: "session.next.step.ended",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      finish: Schema.String,
      cost: Schema.Finite,
      tokens: Schema.Struct({
        input: Schema.Finite,
        output: Schema.Finite,
        reasoning: Schema.Finite,
        cache: Schema.Struct({
          read: Schema.Finite,
          write: Schema.Finite,
        }),
      }),
      snapshot: Schema.String.pipe(optional),
      files: Schema.Array(RelativePath).pipe(optional),
      context: SessionMessage.Context.pipe(optional),
      // Lazy to keep the already-large durable event union below TypeScript's instantiation ceiling.
      timing: Schema.suspend(() => SessionMessage.TurnTiming).pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type

  export const Failed = Event.define({
    type: "session.next.step.failed",
    ...stepSettlementOptions,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      error: UnknownError,
    },
  })
  export type Failed = typeof Failed.Type
}

export namespace Text {
  export const Started = Event.define({
    type: "session.next.text.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Text.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.text.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  /** A storage-linear, idempotent checkpoint over live-only token deltas. */
  export const Progress = Event.define({
    type: "session.next.text.progress",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      offset: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Progress = typeof Progress.Type

  export const Ended = Event.define({
    type: "session.next.text.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      textID: Schema.String,
      text: Schema.String,
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Reasoning {
  export const Started = Event.define({
    type: "session.next.reasoning.started",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Started = typeof Started.Type

  // Stream fragments are live-only; Reasoning.Ended is the replayable full-value boundary.
  export const Delta = Event.define({
    type: "session.next.reasoning.delta",
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      delta: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  /** A storage-linear, idempotent checkpoint over live-only token deltas. */
  export const Progress = Event.define({
    type: "session.next.reasoning.progress",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      offset: NonNegativeInt,
      delta: Schema.String,
    },
  })
  export type Progress = typeof Progress.Type

  export const Ended = Event.define({
    type: "session.next.reasoning.ended",
    ...options,
    schema: {
      ...Base,
      assistantMessageID: SessionMessage.ID,
      reasoningID: Schema.String,
      text: Schema.String,
      providerMetadata: ProviderMetadata.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace Tool {
  const ToolBase = {
    ...Base,
    assistantMessageID: SessionMessage.ID,
    callID: Schema.String,
  }

  export namespace Input {
    export const Started = Event.define({
      type: "session.next.tool.input.started",
      ...options,
      schema: {
        ...ToolBase,
        name: Schema.String,
      },
    })
    export type Started = typeof Started.Type

    // Stream fragments are live-only; Input.Ended is the replayable raw-input boundary.
    export const Delta = Event.define({
      type: "session.next.tool.input.delta",
      schema: {
        ...ToolBase,
        delta: Schema.String,
      },
    })
    export type Delta = typeof Delta.Type

    /** A storage-linear, idempotent checkpoint over live-only token deltas. */
    export const Progress = Event.define({
      type: "session.next.tool.input.progress",
      ...options,
      schema: {
        ...ToolBase,
        offset: NonNegativeInt,
        delta: Schema.String,
      },
    })
    export type Progress = typeof Progress.Type

    export const Ended = Event.define({
      type: "session.next.tool.input.ended",
      ...options,
      schema: {
        ...ToolBase,
        text: Schema.String,
      },
    })
    export type Ended = typeof Ended.Type
  }

  export const Called = Event.define({
    type: "session.next.tool.called",
    ...options,
    schema: {
      ...ToolBase,
      tool: Schema.String,
      // Optional on decode for durable events written before execution receipts shipped. Missing
      // history is treated as external-unknown by recovery; new publishers always write it.
      sideEffect: Schema.Literals(["read", "idempotent-write", "non-idempotent", "external-unknown"]).pipe(optional),
      input: Schema.Record(Schema.String, Schema.Unknown),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Called = typeof Called.Type

  /**
   * A parallel short-answer label for a running tool. The deterministic command-derived label is
   * only a fallback while this arrives; once shown, the generated title is transcript state and
   * must survive message reload and event replay.
   */
  export const Labelled = Event.define({
    type: "session.next.tool.labelled",
    ...options,
    schema: {
      ...ToolBase,
      title: Schema.String,
    },
  })
  export type Labelled = typeof Labelled.Type

  /**
   * Replayable bounded running-tool state. Tools should checkpoint semantic
   * transitions or at a bounded cadence, not persist every stdout/stderr chunk.
   */
  export const Progress = Event.define({
    type: "session.next.tool.progress",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
    },
  })
  export type Progress = typeof Progress.Type

  export const Success = Event.define({
    type: "session.next.tool.success",
    ...options,
    schema: {
      ...ToolBase,
      structured: Schema.Record(Schema.String, Schema.Unknown),
      content: Schema.Array(ToolContent),
      outputPaths: Schema.Array(Schema.String).pipe(optional),
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Success = typeof Success.Type

  export const Failed = Event.define({
    type: "session.next.tool.failed",
    ...options,
    schema: {
      ...ToolBase,
      error: UnknownError,
      result: Schema.Unknown.pipe(optional),
      provider: Schema.Struct({
        executed: Schema.Boolean,
        metadata: ProviderMetadata.pipe(optional),
      }),
    },
  })
  export type Failed = typeof Failed.Type
}

// ⚠️ `session.next.retried` (+ its `session.next.retry_error` payload) was DELETED 2026-07-29 and must
// not come back as a wire type unless something renders it. The runner published one durable row per
// provider retry; the projector line was commented out, `message-updater.ts` mapped it to `Effect.void`,
// `message-fold.ts` no-oped it, and the only card that ever drew it (`session-retry.tsx`) was deleted the
// same day — so every retry since has written a row nothing could ever read. Retiring a durable type is
// safe here by construction: both `EventV2.readAggregate` and `readAfter` filter rows to the CURRENT
// manifest (`inArray(EventTable.type, …)`), so pre-existing `session.next.retried.1` rows are skipped
// rather than decoded. What a retry still produces is a `logWarning` in `runner/llm.ts`, and an
// exhausted retry still reaches the user as the assistant failure with the runner's own `retryable`
// verdict (`session-error.ts`). If a retry should become VISIBLE, build the surface first and add the
// event with it — do not re-add a dark half.

export namespace Compaction {
  export const Started = Event.define({
    type: "session.next.compaction.started",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Schema.Union([Schema.Literal("auto"), Schema.Literal("manual")]),
    },
  })
  export type Started = typeof Started.Type

  export const Delta = Event.define({
    type: "session.next.compaction.delta",
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      text: Schema.String,
    },
  })
  export type Delta = typeof Delta.Type

  /** Durable, bounded progress checkpoint so navigation/reload does not reset the visible count. */
  export const Progress = Event.define({
    type: "session.next.compaction.progress",
    ...options,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      generatedChars: NonNegativeInt,
    },
  })
  export type Progress = typeof Progress.Type

  export const Ended = Event.define({
    type: "session.next.compaction.ended",
    ...compactionSettlementOptions,
    schema: {
      ...Base,
      messageID: SessionMessage.ID,
      reason: Started.data.fields.reason,
      text: Schema.String,
      recent: Schema.String,
      prefixSeq: NonNegativeInt,
      prefixHash: Schema.String,
      generatedChars: NonNegativeInt.pipe(optional),
      /** Present when the pass ended without producing a semantic checkpoint. */
      failure: Schema.String.pipe(optional),
    },
  })
  export type Ended = typeof Ended.Type
}

export namespace RevertEvent {
  export const Staged = Event.define({
    type: "session.next.revert.staged",
    ...options,
    schema: { ...Base, revert: Revert.State },
  })
  export const Cleared = Event.define({ type: "session.next.revert.cleared", ...options, schema: Base })
  export const Committed = Event.define({
    type: "session.next.revert.committed",
    ...options,
    schema: { ...Base, messageID: SessionMessage.ID },
  })
}

export const DurableDefinitions = Event.inventory(
  Completed,
  AgentSwitched,
  ModelSwitched,
  ResponderSwitched,
  ModeSwitched,
  PermissionChanged,
  StrictSwitched,
  FeatureSwitched,
  TypeSwitched,
  PromptOverrideSwitched,
  DeviceSwitched,
  PrioritySwitched,
  ControlBindingSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  ContextUpdated,
  Synthetic,
  ProviderAttempt.Started,
  ProviderAttempt.Settled,
  ProviderAttempt.Abandoned,
  MessageRecorded,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Progress,
  Text.Ended,
  Tool.Input.Started,
  Tool.Input.Progress,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Labelled,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Reasoning.Started,
  Reasoning.Progress,
  Reasoning.Ended,
  Compaction.Started,
  Compaction.Progress,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

export const Definitions = Event.inventory(
  Completed,
  AgentSwitched,
  ModelSwitched,
  ResponderSwitched,
  ModeSwitched,
  PermissionChanged,
  StrictSwitched,
  FeatureSwitched,
  TypeSwitched,
  PromptOverrideSwitched,
  DeviceSwitched,
  PrioritySwitched,
  ControlBindingSwitched,
  Moved,
  Prompted,
  PromptAdmitted,
  ContextUpdated,
  Synthetic,
  ProviderAttempt.Started,
  ProviderAttempt.Settled,
  ProviderAttempt.Abandoned,
  MessageRecorded,
  Shell.Started,
  Shell.Ended,
  Step.Started,
  Step.Ended,
  Step.Failed,
  Text.Started,
  Text.Delta,
  Text.Progress,
  Text.Ended,
  Reasoning.Started,
  Reasoning.Delta,
  Reasoning.Progress,
  Reasoning.Ended,
  Tool.Input.Started,
  Tool.Input.Delta,
  Tool.Input.Progress,
  Tool.Input.Ended,
  Tool.Called,
  Tool.Labelled,
  Tool.Progress,
  Tool.Success,
  Tool.Failed,
  Compaction.Started,
  Compaction.Delta,
  Compaction.Progress,
  Compaction.Ended,
  RevertEvent.Staged,
  RevertEvent.Cleared,
  RevertEvent.Committed,
)

// Keep the runtime union shallow enough for TypeScript to instantiate as this event vocabulary grows.
// Each chunk retains the complete element union at the type level; the slicing only partitions the AST.
type DurableDefinition = (typeof DurableDefinitions)[number]
const durableHead = DurableDefinitions.slice(0, 24) as unknown as readonly [DurableDefinition, ...DurableDefinition[]]
const durableTail = DurableDefinitions.slice(24) as unknown as readonly [DurableDefinition, ...DurableDefinition[]]
const DurableHead = Schema.Union(durableHead, { mode: "oneOf" })
const DurableTail = Schema.Union(durableTail, { mode: "oneOf" })
export const Durable: Schema.toTaggedUnion<"type", readonly [typeof DurableHead, typeof DurableTail]> = Schema.Union(
  [DurableHead, DurableTail],
  { mode: "oneOf" },
)
  .annotate({ identifier: "SessionDurableEvent" })
  .pipe(Schema.toTaggedUnion("type"))
export type DurableEvent = typeof Durable.Type
/** Public wire view without the tagged-union helper's declaration-sized utility type. */
export const DurableWire: Schema.Codec<DurableEvent, unknown> = Durable

type Definition = (typeof Definitions)[number]
const definitionHead = Definitions.slice(0, 28) as unknown as readonly [Definition, ...Definition[]]
const definitionTail = Definitions.slice(28) as unknown as readonly [Definition, ...Definition[]]
const DefinitionHead = Schema.Union(definitionHead, { mode: "oneOf" })
const DefinitionTail = Schema.Union(definitionTail, { mode: "oneOf" })
export const All: Schema.toTaggedUnion<"type", readonly [typeof DefinitionHead, typeof DefinitionTail]> = Schema.Union(
  [DefinitionHead, DefinitionTail],
  { mode: "oneOf" },
).pipe(Schema.toTaggedUnion("type"))
export type Event = typeof All.Type
export type Type = Event["type"]
