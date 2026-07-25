import { SessionMessage } from "@novaclaw/schema/session-message"
import { SessionInput } from "@novaclaw/schema/session-input"
import { PromptInput } from "@novaclaw/schema/prompt-input"
import { Session } from "@novaclaw/schema/session"
import { AbsolutePath, NonNegativeInt, PositiveInt, RelativePath, statics } from "@novaclaw/schema/schema"
import { Workspace } from "@novaclaw/schema/workspace"
import { Context, Effect, Encoding, Result, Schema, SchemaGetter, Struct } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, HttpApiSchema, OpenApi } from "effect/unstable/httpapi"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "../errors"
import { Agent } from "@novaclaw/schema/agent"
import { Model } from "@novaclaw/schema/model"
import { Location } from "@novaclaw/schema/location"
import { Revert } from "@novaclaw/schema/revert"
import { SessionEvent } from "@novaclaw/schema/session-event"
import { SessionFeature } from "@novaclaw/schema/session-feature"
import { SessionStrict } from "@novaclaw/schema/session-strict"
import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { SessionTodo } from "@novaclaw/schema/session-todo"

const SessionsQueryFields = {
  workspace: Workspace.ID.pipe(Schema.optional),
  roots: Schema.Literals(["true", "false"])
    .pipe(
      Schema.decodeTo(Schema.Boolean, {
        decode: SchemaGetter.transform((value) => value === "true"),
        encode: SchemaGetter.transform((value) => (value ? "true" : "false")),
      }),
      Schema.optional,
    )
    .annotate({ description: "When true, only root sessions (no parent) are returned — the threads-tree top level." }),
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(PositiveInt), Schema.optional).annotate({
    description: "Maximum number of sessions to return. Defaults to the newest 50 sessions.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Session order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  search: Schema.optional(Schema.String),
}

const SessionsDirectoryQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath,
})

// T3 (entities.md): the project query is gone — "under a root" is the entity-free repo scope.
const SessionsUnderQuery = Schema.Struct({
  ...SessionsQueryFields,
  under: AbsolutePath,
})

const SessionsAllQuery = Schema.Struct(SessionsQueryFields)

const withCursor = <Fields extends Schema.Struct.Fields>(schema: Schema.Struct<Fields>) =>
  schema.mapFields((fields) => ({
    ...Struct.omit(fields, ["limit"]),
    anchor: Session.ListAnchor,
  }))

const SessionsCursorInput = Schema.Union([
  withCursor(SessionsDirectoryQuery),
  withCursor(SessionsUnderQuery),
  withCursor(SessionsAllQuery),
])
const SessionsCursorJson = Schema.fromJsonString(SessionsCursorInput)
const encodeSessionsCursor = Schema.encodeSync(SessionsCursorJson)
const decodeSessionsCursor = Schema.decodeUnknownEffect(SessionsCursorJson)
const invalidCursor = "Invalid cursor" as const

export const SessionsCursor = Schema.String.pipe(
  Schema.brand("SessionsCursor"),
  statics((schema) => {
    const make = schema.make.bind(schema)
    return {
      make: (input: typeof SessionsCursorInput.Type) => make(Encoding.encodeBase64Url(encodeSessionsCursor(input))),
      parse: (input: string) =>
        Effect.suspend(() => {
          const result = Encoding.decodeBase64UrlString(input)
          return Result.isFailure(result)
            ? Effect.fail(invalidCursor)
            : decodeSessionsCursor(result.success).pipe(Effect.mapError(() => invalidCursor))
        }),
    }
  }),
)
export type SessionsCursor = typeof SessionsCursor.Type

const SessionActive = Schema.Struct({
  type: Schema.Literal("running"),
}).annotate({ identifier: "SessionActive" })

const SessionHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const SessionHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  under: AbsolutePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

export const makeSessionGroup = <I extends HttpApiMiddleware.AnyId, S>(sessionLocationMiddleware: Context.Key<I, S>) =>
  HttpApiGroup.make("server.session")
    .add(
      HttpApiEndpoint.get("session.list", "/api/session", {
        query: SessionsQuery,
        success: Schema.Struct({
          data: Schema.Array(Session.Info),
          cursor: Schema.Struct({
            previous: SessionsCursor.pipe(Schema.optional),
            next: SessionsCursor.pipe(Schema.optional),
          }),
        }).annotate({ identifier: "SessionsResponse" }),
        error: [InvalidCursorError, InvalidRequestError],
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.list",
          summary: "List sessions",
          description:
            "Retrieve sessions in the requested order. Items keep that order across pages; use cursor.next or cursor.previous to move through the ordered list.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.post("session.create", "/api/session", {
        payload: Schema.Struct({
          id: Session.ID.pipe(Schema.optional),
          parentID: Session.ID.pipe(Schema.optional),
          agent: Agent.ID.pipe(Schema.optional),
          model: Model.Ref.pipe(Schema.optional),
          systemPromptOverride: Schema.String.pipe(Schema.optional),
          type: Schema.Literals(["interactive", "sub-agent", "auto-prompting", "goal-oriented"]).pipe(
            Schema.optional,
          ),
          priority: Schema.Finite.pipe(Schema.optional),
          permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]).pipe(Schema.optional),
          location: Location.Ref.pipe(Schema.optional),
          title: Schema.String.pipe(Schema.optional),
          // The caller's explicit saved permission ruleset (the headless runner's allow-all).
          permission: PermissionRuleset.Ruleset.pipe(Schema.optional),
          // Per-session overrides staged from the composer (V1-nuke slice C: these rode $body_
          // extras over the V1 create before).
          strict: SessionStrict.Override.pipe(Schema.optional),
          introspection: Schema.Boolean.pipe(Schema.optional),
          quality: Schema.Boolean.pipe(Schema.optional),
          affective: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: Session.Info }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.create",
          summary: "Create session",
          description: "Create a session at the requested location.",
        }),
      ),
    )
    .add(
      // Tags component (notes/entities.md T0): replace the chat's full tag set. Full-set PUT keeps
      // it idempotent and matches the `session.tags.updated` event, which also carries the list.
      HttpApiEndpoint.put("session.tags.set", "/api/session/:sessionID/tags", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ tags: Schema.Array(Schema.String) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.tags.set",
            summary: "Set session tags",
            description: "Replace the chat's tag set — tags organize chat processes; tag a root to organize its thread tree.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.tags.all", "/api/tag", {
        success: Schema.Struct({ data: Schema.Record(Schema.String, Schema.Array(Schema.String)) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.tags.all",
          summary: "List all session tags",
          description: "The instance-wide tag map: session id → tags. The client store's bootstrap source.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.active", "/api/session/active", {
        success: Schema.Struct({ data: Schema.Record(Session.ID, SessionActive) }),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "v2.session.active",
          summary: "List active sessions",
          description:
            "Retrieve foreground Session drains currently owned by this NovaClaw process. Sessions absent from the result are inactive.",
        }),
      ),
    )
    .add(
      HttpApiEndpoint.get("session.get", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.get",
            summary: "Get session",
            description: "Retrieve a session by ID.",
          }),
        ),
    )
    // V1-nuke A0 (todo.md ☢️): the native twins of the last live bare-/session reads/ops —
    // children (threads tree), update (rename/metadata), remove, fork, todo. Same core ops the V1
    // handlers already routed to (F1c/F1f); only the wire shape changes (native Session.Info).
    .add(
      HttpApiEndpoint.get("session.children", "/api/session/:sessionID/children", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(Session.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.children",
            summary: "List child sessions",
            description: "Retrieve the sessions forked or spawned from the given parent session.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.patch("session.update", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          title: Schema.optional(Schema.String),
          metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
          // Archive/unarchive: epoch millis to archive, null to restore (V1-nuke slice C — the
          // archive flow rode the V1 update route before).
          archived: Schema.optional(Schema.NullOr(Schema.Finite)),
        }),
        success: Schema.Struct({ data: Session.Info }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.update",
            summary: "Update session",
            description: "Rename a session and/or replace its metadata; returns the updated record.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.delete("session.remove", "/api/session/:sessionID", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.remove",
            summary: "Delete session",
            description: "Permanently delete a session and its descendants (messages, todos, tags cascade).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.fork", "/api/session/:sessionID/fork", {
        params: { sessionID: Session.ID },
        // The anchor rides a QUERY param: an all-optional body makes generated clients omit the
        // body entirely (the payload decoder 400s), and NullOr flattens in the generated types.
        query: {
          messageID: Schema.optional(SessionMessage.ID),
        },
        success: Schema.Struct({ data: Session.Info }),
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.fork",
            summary: "Fork session",
            description:
              "Clone a session's transcript into a fresh session, optionally truncated at (and excluding) a message.",
          }),
        ),
    )
    .add(
      // Prompts ADMITTED but not yet promoted into the transcript — what the composer sent while the agent
      // was mid-turn. They are durable and already accepted; they simply have no message row yet, so
      // without this the UI cannot show that they are waiting. `pending` collides with nothing, so the
      // generated client name needs no endpointNames override.
      HttpApiEndpoint.get("session.pending", "/api/session/:sessionID/pending", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({
          data: Schema.Array(
            Schema.Struct({
              id: SessionMessage.ID,
              text: Schema.String,
              delivery: Schema.String,
              timeCreated: Schema.Number,
            }),
          ),
        }).annotate({ identifier: "SessionPendingResponse" }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.pending",
            summary: "Queued prompts not yet read by the agent",
            description:
              "Inputs admitted for this session that the runner has not promoted into the transcript yet, oldest first. A prompt sent mid-turn waits here until the current step finishes; it is never dropped.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.todo", "/api/session/:sessionID/todo", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionTodo.Info) }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.todo",
            summary: "Get session todos",
            description: "Retrieve the todo list the session's agent maintains.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchAgent", "/api/session/:sessionID/agent", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ agent: Agent.ID }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchAgent",
            summary: "Switch session agent",
            description: "Switch the agent used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchModel", "/api/session/:sessionID/model", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ model: Model.Ref }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchModel",
            summary: "Switch session model",
            description: "Switch the model used by subsequent provider turns.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchResponder", "/api/session/:sessionID/responder", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ responder: Schema.Literals(["nova", "operator"]) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchResponder",
            summary: "Switch session responder (B10 handoff)",
            description:
              "Take control (operator) so Nova stops auto-responding, or hand back (nova) so it resumes and drains queued input.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchMode", "/api/session/:sessionID/mode", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchMode",
            summary: "Switch session permission mode (1K)",
            description: "Change the permission mode mid-session; the MODE_RULES overlay applies from the next turn.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchStrict", "/api/session/:sessionID/strict", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ strict: Schema.NullOr(SessionStrict.Override) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchStrict",
            summary: "Set the session's Strict-harness override (jh.md)",
            description:
              "Enable/disable Strict mode for this session and set its racing attempts + time budget; null clears the override back to inherit (parent chain, then global config). Applies from the next turn.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchFeature", "/api/session/:sessionID/feature", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ feature: SessionFeature.Name, enabled: Schema.NullOr(Schema.Boolean) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchFeature",
            summary: "Set a per-session harness-feature override (introspection · quality · affective · thinkingBudget)",
            description:
              "Enable/disable one harness feature for this session; null clears the override back to inherit (parent chain, then global config). Applies from the next turn.",
          }),
        ),
    )
    .add(
      // The composer's Mode control. "sub-agent" is spawn-only (it means "supervised by a parent
      // agent"), so the switch offers the user-meaningful types: interactive vs the unattended pair.
      HttpApiEndpoint.post("session.switchType", "/api/session/:sessionID/type", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ type: Schema.Literals(["interactive", "auto-prompting", "goal-oriented"]) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchType",
            summary: "Set the session's kernel thread type (Mode)",
            description:
              "Switch this chat between interactive and the unattended types (auto-prompting · goal-oriented). Attendance derives from the chain root's type: an unattended chat is CONFINED rather than permissive: out-of-folder writes are DENIED outright instead of parked as an ask nobody can answer, and bash is confined by the Agent Jail (denied outright where no jail backend exists). Applies immediately.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.switchPromptOverride", "/api/session/:sessionID/prompt-override", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ override: Schema.NullOr(Schema.String) }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.switchPromptOverride",
            summary: "Set the session's system-prompt override layer",
            description:
              "Replace this session's system-prompt override (composed after the persona baseline, before the agent prompt); null clears it. Children and forks inherit through the config walk. Applies from the next turn.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.shell", "/api/session/:sessionID/shell", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          command: Schema.String,
        }),
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.shell",
            summary: "Run a shell command",
            description:
              "Run one shell command to completion against the session's location; the transcript renders from the durable shell events (no model turn).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.command", "/api/session/:sessionID/command", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          command: Schema.String,
          arguments: Schema.String,
          // Per-turn agent/model selection, applied to the session before the turn (persisted —
          // the V2 switch semantics).
          agent: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String).annotate({ description: "providerID/modelID" }),
          variant: Schema.optional(Schema.String),
          messageID: Schema.optional(Schema.String),
        }),
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, InvalidRequestError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.command",
            summary: "Run a slash command",
            description:
              "Expand and dispatch a slash command: a prompt-kind command runs a turn on this session; a subtask command spawns a child session (surfaced via session events).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.prompt", "/api/session/:sessionID/prompt", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({
          id: SessionMessage.ID.pipe(Schema.optional),
          prompt: PromptInput.Prompt,
          delivery: SessionInput.Delivery.pipe(Schema.optional),
          resume: Schema.Boolean.pipe(Schema.optional),
        }),
        success: Schema.Struct({ data: SessionInput.Admitted }),
        error: [ConflictError, SessionNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.prompt",
            summary: "Send message",
            description: "Durably admit one session input and schedule agent-loop execution unless resume is false.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.compact", "/api/session/:sessionID/compact", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.compact",
            summary: "Compact session",
            description: "Compact a session conversation.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.wait", "/api/session/:sessionID/wait", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, ServiceUnavailableError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.wait",
            summary: "Wait for session",
            description:
              "Block until the session completes via exit() (its result is recorded). Times out after ~2 minutes with 503 — re-call to continue waiting.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.stage", "/api/session/:sessionID/revert/stage", {
        params: { sessionID: Session.ID },
        payload: Schema.Struct({ messageID: SessionMessage.ID, files: Schema.Boolean.pipe(Schema.optional) }),
        success: Schema.Struct({ data: Revert.State }),
        error: [MessageNotFoundError, SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.revert.stage",
            summary: "Stage session revert",
            description: "Stage or move a reversible session boundary and optionally apply its file changes.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.revert.clear", "/api/session/:sessionID/revert/clear", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" })),
    )
    .add(
      HttpApiEndpoint.post("session.revert.commit", "/api/session/:sessionID/revert/commit", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({ identifier: "v2.session.revert.commit", summary: "Commit staged revert" }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.context", "/api/session/:sessionID/context", {
        params: { sessionID: Session.ID },
        success: Schema.Struct({ data: Schema.Array(SessionMessage.Message) }),
        error: [SessionNotFoundError, UnknownError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.context",
            summary: "Get session context",
            description: "Retrieve the active context messages for a session (all messages after the last compaction).",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.history", "/api/session/:sessionID/history", {
        params: { sessionID: Session.ID },
        query: SessionHistoryQuery,
        success: Schema.Struct({
          data: Schema.Array(SessionEvent.Durable),
          hasMore: Schema.Boolean,
        }).annotate({ identifier: "SessionHistory" }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.history",
            summary: "Get session history",
            description:
              "Read one finite page of public durable Session events after an exclusive aggregate sequence. Newly committed events may appear on later pages.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.events", "/api/session/:sessionID/event", {
        params: { sessionID: Session.ID },
        query: {
          after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
        },
        success: HttpApiSchema.StreamSse({ data: SessionEvent.Durable }),
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.events",
            summary: "Subscribe to session events",
            description: "Replay durable events after an aggregate sequence, then continue with new durable events.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.post("session.interrupt", "/api/session/:sessionID/interrupt", {
        params: { sessionID: Session.ID },
        success: HttpApiSchema.NoContent,
        error: SessionNotFoundError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.interrupt",
            summary: "Interrupt session execution",
            description: "Interrupt active execution owned by this NovaClaw process. Idle interruption is a no-op.",
          }),
        ),
    )
    .add(
      HttpApiEndpoint.get("session.message", "/api/session/:sessionID/message/:messageID", {
        params: { sessionID: Session.ID, messageID: SessionMessage.ID },
        success: Schema.Struct({ data: SessionMessage.Message }),
        error: [SessionNotFoundError, MessageNotFoundError],
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.message",
            summary: "Get session message",
            description: "Retrieve one projected message owned by the Session.",
          }),
        ),
    )
    .annotateMerge(
      OpenApi.annotations({
        title: "sessions",
        description: "Experimental session routes.",
      }),
    )
