import { SessionMessage } from "@novaclaw/schema/session-message"
import { SessionInput } from "@novaclaw/schema/session-input"
import { SessionReceipt as SessionReceiptSchema } from "@novaclaw/schema/session-receipt"
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
import { SessionTodo } from "@novaclaw/schema/session-todo"
import { SessionPresence } from "@novaclaw/schema/session-presence"
import { SessionExecution } from "@novaclaw/schema/session-execution"

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

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// THE RESOLVED-CONFIG VIEW (v0.2.0 batch 4.4).
//
// The kernel's keystone is a parent-chain walk where `undefined` means INHERIT
// (`core/src/session/config-resolve.ts`, AGENTS.md → *The organizing metaphor*). Until this endpoint
// existed, the resolved configuration of a running session was UNOBSERVABLE from outside the
// process: `session.get` returns the raw ROW (i.e. only what this session itself declared, which for
// an inherited field is nothing) and `session.context` returns messages. So *"the child ran under
// the inherited prompt"* was not a checkable statement over HTTP.
//
// ⭐ **WHY THE SHAPE IS AN OPEN MAP AND NOT A STRUCT OF NAMED FIELDS.** `SESSION_CONFIG_FIELDS`
// (ruling 8, widened to a full descriptor by B2) is the ONE declaration of the field set, and this
// package cannot import it — `packages/protocol` depends on `@novaclaw/schema` and `effect`, by
// design. A hand-written struct here would therefore be a SECOND list of the same fields, which is
// exactly the defect ruling 8 came from: a field present in one list and absent from another. So the
// wire is keyed openly and the handler enumerates the descriptor; the equivalence
// (`fields` keys ⇔ `SESSION_CONFIG_FIELD_KEYS`) is asserted where both sides are visible, in
// `packages/server/src/handlers/session-config.test.ts`.
//
// ⚠️ **WHAT THIS VIEW DELIBERATELY DOES NOT COVER**, stated rather than discovered later (ruling 2 —
// a limit described falsely is worse than one described):
//   · A saved per-session permission RULESET. There is no longer one, in either direction: ruling 16
//     removed it from `Session.Info` and from the create payload, because it was written by the edge
//     and read by nobody — `permission.ts` resolves the AGENT's ruleset. One authority for
//     permissions is the decision; a second on the session row is the widening path the org chart
//     calls a coup. ⚠️ An optional field the handler drops is not a smaller version of that: a
//     caller sending a DENY got 2xx and no restriction, and the field is gone from the payload, the
//     OpenAPI spec and the generated SDK so nothing advertises it any more. ⚠️ It is DROPPED, not
//     REFUSED — see the note on `device` below. Old clients that still send it are ignored, which is
//     the residue recorded with the removal rather than a claim that the edge rejects it.
//   · The COMPOSED system prompt. `systemPromptOverride` is a config field and is reported; the text
//     the model actually receives is assembled per turn by `session/runner/system-compose.ts` from
//     the agent definition, project files, memory recall and the tool list. Computing it here would
//     be a second composition site — and it carries far more user content than an override the user
//     typed.
//   · The RUNTIME permission mode. `permissionMode` here is what the config walk resolves. Auto-mode
//     self-grants (`chainAutoGrant`) and the unattended-confinement stance narrow it FURTHER at
//     evaluation time, through the permission service rather than through this walk.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * How ONE resolved `SessionConfig` field got its value.
 *
 * `origin` is the answer to *why*, which is the reason this endpoint exists at all — a value without
 * its origin says what the session runs with but not which ancestor decided it, and debugging
 * inheritance is the whole use case.
 */
const SessionConfigFieldResolution = Schema.Struct({
  /**
   * The effective value. ABSENT means the field resolves to nothing — no layer declared it and
   * `EFFECTIVE_CONFIG_DEFAULTS` carries no value for it (most fields are tri-state: absent = the
   * runner's own fallback applies).
   */
  value: Schema.optional(Schema.Unknown),
  /**
   * The merge strategy the descriptor declares for this field. `narrow` is `permissionMode` only —
   * the root sets it freely and every deeper layer can only make it MORE restrictive — and it is
   * reported because it is what explains a deeper declaration that did not win.
   */
  merge: Schema.Literals(["override", "narrow"]),
  /**
   * The chain layer that SUPPLIED the effective value: the deepest layer at which the resolved value
   * last CHANGED. Absent means no layer moved it — the value came from the global defaults (or
   * nothing declared it).
   *
   * ⚠️ Read it together with `declaredBy`, because "supplied" is not "declared". A layer that
   * re-declares the value its parent already resolved to does not move it, and under `narrow` a
   * deeper layer asking for MORE capability does not move it either. Both cases show up as a
   * `declaredBy` entry deeper than `origin`, which is precisely the situation worth seeing.
   */
  origin: Session.ID.pipe(Schema.optional),
  /** Every chain layer that declared this field, root-first. */
  declaredBy: Schema.Array(Session.ID),
  /**
   * Where the value came from when NO chain layer supplied it — i.e. whenever `origin` is absent
   * but a `value` is present.
   *
   * 🔴 `origin` can only ever name a SESSION, so every layer beneath the entity collapsed into "no
   * origin": a component the instance ships and one this folder's `novaclaw.json` asked for looked
   * identical on the wire. That is the one question a person opening this surface is asking — *did I
   * set this, or did my project?* — and answering it with silence is the confident-falsehood shape,
   * not a missing feature.
   *
   * `project` carries the FILE, because the useful next action is opening it.
   */
  source: Schema.optional(
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal("instance") }),
      Schema.Struct({ kind: Schema.Literal("project"), file: Schema.String }),
      // The COLLEAGUE whose chat this is chose the value — its model, posture, Strict or permission
      // mode. Ranked below `project`, matching the fold: a folder's tune overrides the officer, so a
      // field a folder claimed reports as `project` even when the colleague declared it too.
      Schema.Struct({ kind: Schema.Literal("agent"), agentID: Schema.String }),
    ]),
  ),
}).annotate({ identifier: "SessionConfigFieldResolution" })

export const SessionConfigResolved = Schema.Struct({
  sessionID: Session.ID,
  /** The `[root … session]` chain the walk actually followed, root-first. */
  chain: Schema.Array(Session.ID),
  /**
   * The layer the chain resolved against — what an absent `origin` points at. The shipped defaults
   * with this folder's applied tune folded on top, so it is the base the TURN used, not a generic one.
   */
  defaults: Schema.Record(Schema.String, Schema.Unknown),
  /** The `novaclaw.json` governing the session's folder, when one does. */
  project: Schema.optional(
    Schema.Struct({
      /** The directory holding the file. */
      root: Schema.String,
      file: Schema.String,
      /** The switches the file supplied — every one of them shows as `source.kind === "project"`. */
      applied: Schema.Array(Schema.String),
      /** Declared and refused: a folder may raise a supervision switch, never lower one. */
      refused: Schema.Array(Schema.String),
    }),
  ),
  /** The merged effective config, flat. Every entry equals its `fields[key].value`. */
  resolved: Schema.Record(Schema.String, Schema.Unknown),
  /** Per-field provenance, keyed by `SessionConfig` field name (see the block above). */
  fields: Schema.Record(Schema.String, SessionConfigFieldResolution),
}).annotate({ identifier: "SessionConfigResolved" })

const SessionHistoryLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(100))

export const SessionHistoryQuery = Schema.Struct({
  limit: Schema.NumberFromString.pipe(Schema.decodeTo(SessionHistoryLimit), Schema.optional),
  after: Schema.NumberFromString.pipe(Schema.decodeTo(NonNegativeInt), Schema.optional),
})

export class SessionHistoryResponse extends Schema.Class<SessionHistoryResponse>("SessionHistory")({
  data: Schema.Array(SessionEvent.DurableWire),
  hasMore: Schema.Boolean,
}) {}

const SessionsQueryCursor = SessionsCursor.annotate({
  description: "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response.",
})

export const SessionsQuery = Schema.Struct({
  ...SessionsQueryFields,
  directory: AbsolutePath.pipe(Schema.optional),
  under: AbsolutePath.pipe(Schema.optional),
  cursor: SessionsQueryCursor.pipe(Schema.optional),
}).annotate({ identifier: "SessionsQuery" })

/**
 * 🔴 **`session.create` needs `locationMiddleware`, and that is why this now takes two.**
 *
 * Every session-SCOPED endpoint below uses `sessionLocationMiddleware`, which derives the location
 * from the session named in the path. A CREATE has no session yet, so it carried NEITHER middleware
 * and had no way to see the directory the request named — and `handlers/session.ts` filled that gap
 * with `process.cwd()`, filing every such session under the SERVER PROCESS's directory.
 *
 * ⚠️ That is only harmless for a CLI, where the process and the user's directory coincide. On the
 * shipped headless/remote path (R1–R8) the server's cwd is a service directory unrelated to the
 * user's, so the session landed somewhere `list` — which does honour the request's location — would
 * never look again.
 *
 * Shape copied from `makePermissionGroup`, which already takes both for the same reason.
 */
export const makeSessionGroups = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  I extends HttpApiMiddleware.AnyId,
  S,
  WorkspaceRoutingId extends HttpApiMiddleware.AnyId,
  WorkspaceRoutingService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<I, S>,
  workspaceRoutingMiddleware: Context.Key<WorkspaceRoutingId, WorkspaceRoutingService>,
) =>
  [
    HttpApiGroup.make("server.session.catalog")
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
            // Device placement (v0.2.0 B2) — a real `DeviceRegistry` id that must contain a catalog
            // placement of the resolved model. The runner validates it before provider dispatch and
            // derives admission identity from that placement; this string can never mint a gate.
            // Without this line the field is DROPPED at the
            // edge rather than passed through: a `session.device` column with no wire writer would be
            // settable by nothing outside the kernel, which is the inert shape B2's first step
            // deleted three fields for.
            //
            // 🔴 **DROPPED, not REJECTED — this comment and its twin below said "REJECTED" until
            // 2026-08-26, and the OpenAPI projection they cited is not the enforcement.** The spec
            // does emit `additionalProperties: false`, but effect 4.0.0-beta.83 decodes objects with
            // `onExcessProperty: "ignore"` by DEFAULT and `effect/unstable/httpapi` never overrides
            // it (the option name appears nowhere in that directory). Measured through the real
            // declared endpoint: a body carrying an unlisted key decodes to the listed keys only and
            // the request SUCCEEDS. So an unlisted field cannot reach the handler — which is all the
            // argument above needs — but a client is never TOLD it was ignored. That distinction is
            // the whole of NC-SEC-012, and the spec promising a rejection the runtime does not
            // perform is its own honesty defect (ruling 2), not something to re-derive from here.
            device: Schema.NonEmptyString.pipe(Schema.optional),
            controlBinding: Schema.NonEmptyString.pipe(Schema.optional),
            systemPromptOverride: Schema.String.pipe(Schema.optional),
            type: Schema.Literals(["interactive", "sub-agent", "auto-prompting", "goal-oriented"]).pipe(
              Schema.optional,
            ),
            priority: Schema.Finite.pipe(Schema.optional),
            permissionMode: Schema.Literals(["plan", "ask", "surgical", "bypass", "yolo"]).pipe(Schema.optional),
            responder: Schema.Literals(["nova", "operator"]).pipe(Schema.optional),
            location: Location.Ref.pipe(Schema.optional),
            title: Schema.String.pipe(Schema.optional),
            // Per-session overrides staged from the composer (V1-nuke slice C: these rode $body_
            // extras over the V1 create before).
            //
            // ⚠️ EVERY member of `SessionFeature.Name` belongs here: a missing field is not "passed
            // through unread", it is DROPPED at the edge and never reaches the handler (see the
            // `device` note above for why that is dropped rather than rejected). From the landing of `safeMode` (2026-07-31) until 2026-07-31 only
            // the first three were listed, so a draft that ticked *Safe mode*, *Ask before changes* or
            // *Surgical edits* in the composer's Tuning panel created a session without them: three
            // RESTRICTIONS the UI accepted and the wire discarded, which is ruling 2 (*a failed
            // mutation never reports success*) on the surface a user actually touches.
            //
            // ⚠️ Each is a TRI-STATE, never a boolean with a default: absent = INHERIT (the parent
            // chain, then the global config block), which is the ECS sparse-override discipline
            // (`todo.md` → *The ECS lens*; `session/config-resolve.ts`). Giving any of them a
            // `Schema.withDecodingDefault` would stamp a stance into every new session — for the three
            // narrowing switches that would silently WIDEN a fork of a restricted parent, which
            // ruling 8 calls a defect rather than a preference.
            //
            // `packages/server/src/handlers/session-create-features.test.ts` is the ratchet: it reads
            // the field list off `SessionFeature.Name` and drives the real registered handler, so an
            // eighth kernel feature fails there until this payload and the handler both carry it.
            strict: SessionStrict.Override.pipe(Schema.optional),
            introspection: Schema.Boolean.pipe(Schema.optional),
            quality: Schema.Boolean.pipe(Schema.optional),
            affective: Schema.Boolean.pipe(Schema.optional),
            thinkingBudget: Schema.Boolean.pipe(Schema.optional),
            surgicalEdits: Schema.Boolean.pipe(Schema.optional),
            askBeforeChanges: Schema.Boolean.pipe(Schema.optional),
            safeMode: Schema.Boolean.pipe(Schema.optional),
            contextBudget: Schema.Boolean.pipe(Schema.optional),
            memory: Schema.Boolean.pipe(Schema.optional),
            shortChat: Schema.Boolean.pipe(Schema.optional),
          }),
          success: Schema.Struct({ data: Session.Info }),
          /**
           * 🔴 NC-SEC-020 — a ROOT create without an `agent` is REFUSED, not silently attributed.
           *
           * `agent` stays optional in the payload because on a CHILD its absence means *inherit from
           * the parent*, which is legitimate. On a root it meant nothing at all, and the row's owner
           * was then re-derived per turn from whatever the current default officer happened to be.
           * A caller error with a correct action attached — say whose chat it is — so it belongs in
           * the error channel rather than in a crash log.
           */
          error: InvalidRequestError,
        })
          // 🔴 Without this the handler cannot resolve `Location.Service` and has nothing to fall back
          // on but `process.cwd()`. The description right below has always said "at the requested
          // location" — this is what makes that true when the payload omits one.
          .middleware(locationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.create",
              summary: "Create session",
              description: "Create a session at the requested location.",
            }),
          ),
      )
      .add(
        // Tags component (notes/reports/entities-review-2026-07-06.md T0): replace the chat's full tag set. Full-set PUT keeps
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
              description:
                "Replace the chat's tag set — tags organize chat processes; tag a root to organize its thread tree.",
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
        // Presence component: one idempotent call carries attach, heartbeat, take-over and goodbye.
        // Splitting them into four endpoints would make the client decide which state it is in —
        // exactly the bookkeeping a surface gets wrong after a reconnect.
        HttpApiEndpoint.post("session.presence.report", "/api/session/:sessionID/presence", {
          params: { sessionID: Session.ID },
          payload: Schema.Struct({
            viewerID: Schema.NonEmptyString,
            kind: SessionPresence.ViewerKind,
            label: Schema.NonEmptyString,
            writing: Schema.Boolean.pipe(Schema.optional),
            action: Schema.Literals(["report", "claim", "detach"]),
          }),
          success: Schema.Struct({ data: SessionPresence.Snapshot }),
          error: SessionNotFoundError,
        })
          // Not for the location services — for the 404. This middleware already proves the session
          // exists before the handler runs, which is what keeps an in-memory presence map from
          // growing a room for a session id that was never real.
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.presence.report",
              summary: "Report presence on a session",
              description:
                "Attach a viewer, say 'still here', take over control, or detach. Returns the session's whole presence snapshot; every attached surface also receives it as `session.presence.updated`.",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.get("session.presence.all", "/api/presence", {
          success: Schema.Struct({ data: Schema.Record(Session.ID, SessionPresence.Snapshot) }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.presence.all",
            summary: "List session presence",
            description:
              "Sessions with someone attached right now: session id → presence. The client store's bootstrap source; sessions absent from the result are unattended. This instance answers only for its OWN sessions — it is not a directory of who is online.",
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
        HttpApiEndpoint.get("session.execution.list", "/api/session/execution", {
          query: {
            sessionID: Schema.optional(Session.ID),
          },
          success: Schema.Struct({ data: Schema.Array(SessionExecution.Info) }),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "v2.session.execution.list",
            summary: "Inspect durable session execution",
            description:
              "List durable execution and recovery state, including paused failures and their human-readable details. Pass sessionID to inspect one session without transferring the whole ledger.",
          }),
        ),
      )
      .add(
        /**
         * "What Nova checked" — the task receipt for this session's CURRENT attempt.
         *
         * Mechanical evidence is authoritative, so every field is
         * read from a table something else wrote as it happened. ⚠️ A session that has never run
         * answers 404, not an empty receipt — an empty one asserts that nothing happened, which is a
         * different claim from "nothing ran yet".
         */
        HttpApiEndpoint.get("session.receipt", "/api/session/:sessionID/receipt", {
          params: { sessionID: Session.ID },
          success: Schema.Struct({ data: SessionReceiptSchema.Info }),
          error: SessionNotFoundError,
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.receipt",
              summary: "Task receipt",
              description:
                "What this session's current attempt declared and what it checked: the frozen plan, " +
                "each quality check that ran with its command and exit code, and any spawned children.",
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
      // Placed beside `children` rather than beside `update`: both are reads ABOUT the session tree,
      // and this one is the only way to observe the tree's effect on a session from outside the process.
      .add(
        HttpApiEndpoint.get("session.config", "/api/session/:sessionID/config", {
          params: { sessionID: Session.ID },
          success: Schema.Struct({ data: SessionConfigResolved }),
          error: SessionNotFoundError,
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.config",
              summary: "Resolve session config",
              description:
                "Resolve a session's effective configuration by walking its parent chain root-ward (undefined = inherit), and report which ancestor supplied each field. Covers the SessionConfig fields only: the saved permission ruleset does not resolve through this walk, the reported permissionMode is the config-walk result before auto-mode grants and the unattended stance narrow it further, and systemPromptOverride is the per-session override rather than the composed system prompt.",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.patch("session.update", "/api/session/:sessionID", {
          params: { sessionID: Session.ID },
          payload: Schema.Struct({
            title: Schema.optional(Schema.String),
            metadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
            /** A string pins a real Device; null removes the sparse override and restores automatic placement. */
            device: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
            // Archive/unarchive: epoch millis to archive, null to restore (V1-nuke slice C — the
            // archive flow rode the V1 update route before).
            archived: Schema.optional(Schema.NullOr(Schema.Finite)),
          }),
          success: Schema.Struct({ data: Session.Info }),
          error: [SessionNotFoundError, InvalidRequestError],
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.update",
              summary: "Update session",
              description:
                "Rename a session, replace its metadata, archive it, or set/remove its Device pin; returns the updated record.",
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
      // 🔴 **One tag per group, and each name distinct.** All four session groups used to declare
      // the single name `sessions`, which put 41 operations in one undifferentiated heading AND
      // pushed four identically-named entries into the document's `tags` array — names OpenAPI 3.1
      // requires to be unique, and which renderers turn into four duplicate navigation sections.
      // The split into four groups already exists for middleware reasons and it happens to be the
      // honest taxonomy: the roster, what a session runs WITH, driving its turn, and watching it.
      .annotateMerge(
        OpenApi.annotations({
          title: "sessions",
          description:
            "The session roster: create, list, read, retitle, tag, fork and remove a session, and see who is attached to one.",
        }),
      )
      .middleware(workspaceRoutingMiddleware),
    HttpApiGroup.make("server.session.control")
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
                timeCreated: Schema.Finite,
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
          // 409, not 503: one chat per colleague. `ServiceUnavailableError` — the mapping the other
          // `OperationUnavailableError` routes use — would read "not available yet", which is untrue
          // here. The operation is available; this particular request conflicts.
          error: [SessionNotFoundError, ConflictError],
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.switchAgent",
              summary: "Switch session agent",
              description:
                "Switch the agent used by subsequent provider turns. Refuses with 409 when that " +
                "colleague already has a chat — a colleague has exactly one.",
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
        HttpApiEndpoint.get("session.folder", "/api/session/:sessionID/folder", {
          params: { sessionID: Session.ID },
          success: Schema.Struct({
            data: Schema.Struct({
              directory: AbsolutePath,
              /**
               * The folder this session was created in, present ONLY while it is running somewhere
               * else because that one went missing. Its absence is the normal case, not an unknown:
               * a session with no recorded recovery is simply working where it was asked to.
               */
              missing: Schema.optional(AbsolutePath),
            }),
          }),
          error: SessionNotFoundError,
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.folder",
              summary: "Where a session is working, and what it lost",
              description:
                "The session's current working folder, plus the folder it was created in when that one has gone " +
                "missing and the session was degraded into a scratch folder. `missing` is what lets a client offer to " +
                "repoint: without it the substitution is only visible as a one-off notice in the transcript, which a " +
                "reader who returns later has already scrolled past.",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.post("session.repointFolder", "/api/session/:sessionID/folder", {
          params: { sessionID: Session.ID },
          payload: Schema.Struct({ directory: AbsolutePath }),
          success: HttpApiSchema.NoContent,
          // Two refusals with genuinely different meanings: the session is not there (404), or the
          // folder is (400 — unresolvable, or outside this session's project).
          error: Schema.Union([SessionNotFoundError, InvalidRequestError]),
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.repointFolder",
              summary: "Point a session at a different working folder",
              description:
                "Move this session's working folder. Written through the `working_folder` session component, so it " +
                "re-derives project identity, publishes the same Moved event an agent's own move would, and clears any " +
                "recorded missing-folder recovery. Exists because a folder that moved is something the USER knows and " +
                "the agent does not: when a working folder disappears the session degrades into a scratch folder and " +
                "keeps running, and only a person can say where the real one went.",
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
              summary:
                "Set a per-session harness-feature override (introspection · quality · affective · thinkingBudget)",
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
      .annotateMerge(
        OpenApi.annotations({
          title: "session control",
          description:
            "What a session runs WITH: switch its agent, model, responder, permission mode, folder, strictness, features and prompt override, and dispatch a shell or slash command.",
        }),
      )
      .middleware(workspaceRoutingMiddleware),
    HttpApiGroup.make("server.session.runtime")
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
                "Block until the session completes via exit() (its result is recorded). Times out after ~10 minutes with 503 — re-call to continue waiting.",
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
          .annotateMerge(
            OpenApi.annotations({ identifier: "v2.session.revert.clear", summary: "Clear staged revert" }),
          ),
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
      .annotateMerge(
        OpenApi.annotations({
          title: "session runtime",
          description:
            "Drive a session's turn: prompt it, wait for it to settle, compact it, and stage or commit a revert.",
        }),
      )
      .middleware(workspaceRoutingMiddleware),
    HttpApiGroup.make("server.session.observation")
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
              description:
                "Retrieve the active context messages for a session (all messages after the last compaction).",
            }),
          ),
      )
      .add(
        HttpApiEndpoint.get("session.history", "/api/session/:sessionID/history", {
          params: { sessionID: Session.ID },
          query: SessionHistoryQuery,
          success: SessionHistoryResponse,
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
          success: HttpApiSchema.StreamSse({ data: SessionEvent.DurableWire }),
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
          payload: Schema.Struct({ reason: Schema.String.pipe(Schema.optional) }),
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
        HttpApiEndpoint.post("session.execution.retry", "/api/session/:sessionID/execution/retry", {
          params: { sessionID: Session.ID },
          success: HttpApiSchema.NoContent,
          error: SessionNotFoundError,
        })
          .middleware(sessionLocationMiddleware)
          .annotateMerge(
            OpenApi.annotations({
              identifier: "v2.session.execution.retry",
              summary: "Retry paused session execution",
              description:
                "Record explicit operator authority, reset the recovery circuit breaker, and resume queued work without requiring a model response.",
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
          title: "session observation",
          description:
            "Watch a session without changing it: its live context, its history, its event stream, one projected message — and the interrupt that stops a turn.",
        }),
      )
      // 🔴 **Workspace routing, at the GROUP level — the whole native session surface, not one endpoint.**
      // Until 2026-08-07 this group declared no workspace routing at all, because the middleware KEY
      // lived in `packages/novaclaw` where this package cannot reach it. The consequence was not
      // cosmetic: a request for a session owned by a REMOTE workspace was served LOCALLY, against the
      // wrong working tree, and answered 200 — indistinguishable from a correctly proxied call.
      //
      // ⚠️ Group level rather than per-endpoint deliberately: session OWNERSHIP is a property of the
      // session, not of the verb, so any route naming a session can need proxying. Picking endpoints
      // one at a time is how the gap appeared in the first place.
      .middleware(workspaceRoutingMiddleware),
  ] as const
