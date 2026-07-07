import { PermissionV1 } from "@novaclaw/core/v1/permission"
import { SessionV1 } from "@novaclaw/core/v1/session"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Command } from "@/command"
import { Permission } from "@/permission"
import { SessionShare } from "@/share/session"
import { Session } from "@/session/session"
import { MessageV2 } from "@/session/message-v2"
import { SessionPrompt } from "@/session/prompt"
import { SessionRunState } from "@/session/run-state"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionV1Read } from "@novaclaw/core/session/v1-read"
import { Database } from "@novaclaw/core/database/database"
import { InstanceState } from "@/effect/instance-state"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { PromptInput } from "@novaclaw/schema/prompt-input"
import { SessionStatus } from "@/session/status"
import { SessionSummary } from "@/session/summary"
import { Todo } from "@/session/todo"
import { MessageID, PartID, SessionID } from "@/session/schema"
import { NamedError } from "@novaclaw/core/util/error"
import { Cause, Effect, Option, Schema, Scope } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiError, HttpApiSchema } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import {
  CommandPayload,
  DiffQuery,
  ForkPayload,
  InitPayload,
  ListQuery,
  MessagesQuery,
  PermissionResponsePayload,
  PromptPayload,
  RevertPayload,
  ShellPayload,
  SummarizePayload,
  UpdatePayload,
} from "../groups/session"
import { InvalidRequestError, PermissionNotFoundError, notFound } from "../errors"
import * as SessionError from "./session-errors"

const tryParseJson = (text: string) =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: () => new HttpApiError.BadRequest({}),
  })

// Map a legacy PromptPayload (the v1 wire shape) onto the V2 PromptInput.Prompt
// the V2 session admits. Concatenate text parts (newline-joined), carry file
// parts as {uri, name} (the V2 FileAttachment has NO mime — resolvePrompt derives
// it downstream) and agent parts as {name}. Each carries its inline @-mention
// `source` span ({start,end,text}) when present so the native user message stays
// faithful: fork/undo/command reconstruct the composer Prompt from it (F1e S5).
// All three FilePartSource variants (file/symbol/resource) share `.text`. Subtask
// + any other part types are dropped (V2 has no inline subtask prompt-part).
// Exported for unit testing.
type V2File = NonNullable<(typeof PromptInput.Prompt.Type)["files"]>[number]
type V2Agent = NonNullable<(typeof PromptInput.Prompt.Type)["agents"]>[number]
export const toV2Prompt = (payload: typeof PromptPayload.Type): typeof PromptInput.Prompt.Type => {
  const texts: string[] = []
  const files: V2File[] = []
  const agents: V2Agent[] = []
  for (const part of payload.parts) {
    switch (part.type) {
      case "text":
        texts.push(part.text)
        break
      case "file":
        files.push({
          uri: part.url,
          ...(part.filename ? { name: part.filename } : {}),
          ...(part.source
            ? { source: { start: part.source.text.start, end: part.source.text.end, text: part.source.text.value } }
            : {}),
        })
        break
      case "agent":
        agents.push({
          name: part.name,
          ...(part.source
            ? { source: { start: part.source.start, end: part.source.end, text: part.source.value } }
            : {}),
        })
        break
      default:
        // subtask + unknown → dropped
        break
    }
  }
  return PromptInput.Prompt.make({
    text: texts.join("\n"),
    ...(files.length ? { files } : {}),
    ...(agents.length ? { agents } : {}),
  })
}

export const sessionHandlers = HttpApiBuilder.group(InstanceHttpApi, "session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* Session.Service
    const shareSvc = yield* SessionShare.Service
    const promptSvc = yield* SessionPrompt.Service
    const runState = yield* SessionRunState.Service
    const permissionSvc = yield* Permission.Service
    const statusSvc = yield* SessionStatus.Service
    const sessionV2 = yield* SessionV2.Service
    const { db } = yield* Database.Service
    const todoSvc = yield* Todo.Service
    const summary = yield* SessionSummary.Service
    const events = yield* EventV2Bridge.Service
    const scope = yield* Scope.Scope

    const list = Effect.fn("SessionHttpApi.list")(function* (ctx: { query: typeof ListQuery.Type }) {
      // F1c read-sweep B: the project scoping V1 resolved ambiently (InstanceState inside the
      // service) is resolved HERE and passed explicitly — core takes only data.
      const instance = yield* InstanceState.context
      return yield* SessionV1Read.list(db, {
        projectID: instance.project.id,
        directory: ctx.query.scope === "project" ? undefined : ctx.query.directory,
        scope: ctx.query.scope,
        path: ctx.query.path,
        roots: ctx.query.roots,
        start: ctx.query.start,
        search: ctx.query.search,
        limit: ctx.query.limit,
      })
    })

    const status = Effect.fn("SessionHttpApi.status")(function* () {
      return Object.fromEntries(yield* statusSvc.list())
    })

    // F1c read-sweep: session-level reads come from core in the LEGACY wire shape
    // (row-faithful `v1InfoFromRow` — the same vocabulary the session-level events carry),
    // with the pinned 404 contract ("Session not found: <id>") preserved.
    const requireSession = Effect.fn("SessionHttpApi.requireSession")(function* (sessionID: SessionID) {
      const info = yield* SessionV1Read.get(db, sessionID)
      if (!info) return yield* notFound(`Session not found: ${sessionID}`)
      return info
    })

    const get = Effect.fn("SessionHttpApi.get")(function* (ctx: { params: { sessionID: SessionID } }) {
      return yield* requireSession(ctx.params.sessionID)
    })

    const children = Effect.fn("SessionHttpApi.children")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* SessionV1Read.children(db, ctx.params.sessionID)
    })

    const todo = Effect.fn("SessionHttpApi.todo")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      return yield* todoSvc.get(ctx.params.sessionID)
    })

    const diff = Effect.fn("SessionHttpApi.diff")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof DiffQuery.Type
    }) {
      return yield* summary.diff({ sessionID: ctx.params.sessionID, messageID: ctx.query.messageID })
    })

    const messages = Effect.fn("SessionHttpApi.messages")(function* (ctx: {
      params: { sessionID: SessionID }
      query: typeof MessagesQuery.Type
    }) {
      if (ctx.query.before && ctx.query.limit === undefined) return yield* new HttpApiError.BadRequest({})
      if (ctx.query.before) {
        const before = ctx.query.before
        yield* Effect.try({
          try: () => MessageV2.cursor.decode(before),
          catch: () => new HttpApiError.BadRequest({}),
        })
      }
      yield* requireSession(ctx.params.sessionID)
      if (ctx.query.limit === undefined || ctx.query.limit === 0) {
        return yield* SessionError.mapStorageNotFound(session.messages({ sessionID: ctx.params.sessionID }))
      }

      const page = yield* SessionError.mapStorageNotFound(
        MessageV2.page({
          sessionID: ctx.params.sessionID,
          limit: ctx.query.limit,
          before: ctx.query.before,
        }),
      )
      if (!page.cursor) return page.items

      const request = yield* HttpServerRequest.HttpServerRequest
      // toURL() honors the Host + x-forwarded-proto headers, so the Link
      // header echoes the real origin instead of a hard-coded localhost.
      const url = Option.getOrElse(HttpServerRequest.toURL(request), () => new URL(request.url, "http://localhost"))
      url.searchParams.set("limit", ctx.query.limit.toString())
      url.searchParams.set("before", page.cursor)
      return HttpServerResponse.jsonUnsafe(page.items, {
        headers: {
          "Access-Control-Expose-Headers": "Link, X-Next-Cursor",
          Link: `<${url.toString()}>; rel="next"`,
          "X-Next-Cursor": page.cursor,
        },
      })
    })

    const message = Effect.fn("SessionHttpApi.message")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      return yield* SessionError.mapStorageNotFound(
        MessageV2.get({ sessionID: ctx.params.sessionID, messageID: ctx.params.messageID }),
      )
    })

    const create = Effect.fn("SessionHttpApi.create")(function* (ctx: { payload?: Session.CreateInput }) {
      return yield* shareSvc.create(ctx.payload)
    })

    const createRaw = Effect.fn("SessionHttpApi.createRaw")(function* (ctx: {
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* create({})

      const json = yield* tryParseJson(body)
      const decoded = yield* Schema.decodeUnknownEffect(Session.CreateInput)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      const payload = decoded
        ? {
            ...decoded,
            permission: decoded.permission ? [...decoded.permission] : undefined,
          }
        : decoded
      return yield* create({ payload })
    })

    const remove = Effect.fn("SessionHttpApi.remove")(function* (ctx: { params: { sessionID: SessionID } }) {
      // F1c: delete routes to the core engine (interrupts an active run, recurses children,
      // publishes the legacy `session.deleted`, purges the aggregate log). V1's background-job
      // sweep is not reproduced — post-F1b nothing tags BackgroundJobs with session metadata.
      yield* requireSession(ctx.params.sessionID)
      yield* sessionV2.remove(ctx.params.sessionID).pipe(Effect.orDie)
      return true
    })

    const update = Effect.fn("SessionHttpApi.update")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof UpdatePayload.Type
    }) {
      const current = yield* requireSession(ctx.params.sessionID)
      // F1c: every update op routes to the core engine (V1 parity: the same full-info
      // `session.updated` publish; the projector writes the row before the re-read below).
      if (ctx.payload.title !== undefined) {
        yield* sessionV2.setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title }).pipe(Effect.orDie)
      }
      if (ctx.payload.metadata !== undefined) {
        yield* sessionV2
          .setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
          .pipe(Effect.orDie)
      }
      if (ctx.payload.permission !== undefined) {
        yield* sessionV2
          .setPermission({
            sessionID: ctx.params.sessionID,
            permission: Permission.merge(current.permission ?? [], ctx.payload.permission),
          })
          .pipe(Effect.orDie)
      }
      if (ctx.payload.time?.archived !== undefined) {
        yield* sessionV2
          .setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.time.archived })
          .pipe(Effect.orDie)
      }
      return yield* requireSession(ctx.params.sessionID)
    })

    const fork = Effect.fn("SessionHttpApi.fork")(function* (ctx: {
      params: { sessionID: SessionID }
      payload?: typeof ForkPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // F1c: fork routes to the core engine — the V1 fork copied only the legacy message
      // store, which native sessions never write, so post-F1b a fork silently lost its
      // transcript. An unknown anchor message is a client error (the app only offers real
      // transcript messages), not a server fault.
      const forked = yield* sessionV2
        .fork({
          sessionID: ctx.params.sessionID,
          messageID: ctx.payload?.messageID ? SessionMessage.ID.make(ctx.payload.messageID) : undefined,
        })
        .pipe(
          Effect.catch((error) =>
            error._tag === "Session.MessageNotFoundError"
              ? Effect.fail(new HttpApiError.BadRequest({}))
              : Effect.die(error),
          ),
        )
      return yield* requireSession(forked.id)
    })

    const forkRaw = Effect.fn("SessionHttpApi.forkRaw")(function* (ctx: {
      params: { sessionID: SessionID }
      request: HttpServerRequest.HttpServerRequest
    }) {
      const body = yield* Effect.orDie(ctx.request.text)
      if (body.trim().length === 0) return yield* fork({ params: ctx.params })

      const json = yield* tryParseJson(body)
      const payload = yield* Schema.decodeUnknownEffect(ForkPayload)(json).pipe(
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )
      return yield* fork({ params: ctx.params, payload })
    })

    const abort = Effect.fn("SessionHttpApi.abort")(function* (ctx: { params: { sessionID: SessionID } }) {
      // F1b: every session runs V2 turns — interrupt the V2 runner unconditionally
      // (the interrupt absorbs its typed not-found failure; abort stays total). We
      // ALSO call the legacy cancel — a harmless no-op with no V1 runner, guarding
      // against an orphaned V1 background job until F1f deletes the engine. We do
      // NOT emit idle here: the V2 turn fiber's `ensuring` owns the idle transition.
      yield* sessionV2.interrupt(ctx.params.sessionID).pipe(Effect.orElseSucceed(() => undefined))
      yield* promptSvc.cancel(ctx.params.sessionID)
      return true
    })

    const init = Effect.fn("SessionHttpApi.init")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof InitPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // init ≡ the built-in `init` command (V1 did exactly this against its own command op).
      yield* sessionV2
        .switchModel({
          sessionID: ctx.params.sessionID,
          model: { id: ctx.payload.modelID, providerID: ctx.payload.providerID },
        })
        .pipe(Effect.orDie)
      const result = yield* sessionV2
        .command({
          sessionID: ctx.params.sessionID,
          command: Command.Default.INIT,
          arguments: "",
          id: ctx.payload.messageID as unknown as Parameters<typeof sessionV2.command>[0]["id"],
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      if (result.type === "prompt") yield* forkV2Turn(ctx.params.sessionID)
      return true
    })

    // share/unshare errors aren't all client-induced — storage and network
    // failures from SessionShare are real possibilities. Map to a typed 500
    // (matches the legacy route behavior which routed any failure through
    // ErrorMiddleware → NamedError.Unknown 500) instead of blanket-mapping
    // every failure to a 400 BadRequest.
    const share = Effect.fn("SessionHttpApi.share")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc.share(ctx.params.sessionID).pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const unshare = Effect.fn("SessionHttpApi.unshare")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* shareSvc
        .unshare(ctx.params.sessionID)
        .pipe(Effect.mapError(() => new HttpApiError.InternalServerError({})))
      return yield* requireSession(ctx.params.sessionID)
    })

    const summarize = Effect.fn("SessionHttpApi.summarize")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof SummarizePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // F1a SLICE 7 wiring (F1b: now the only path): the V2 compact marks the runner's one-shot
      // compaction request and wakes the session; the runner's compact-only cycle emits
      // Compaction.Started/Ended with reason "manual". The V2 path compacts with the SESSION's
      // own model — the payload's model choice was a V1-only affordance (residue: honor it if a
      // per-op override is wanted).
      yield* sessionV2.compact({ sessionID: ctx.params.sessionID }).pipe(Effect.orDie)
      return true
    })

    // F1a SLICE 8: the blocking one-shot `prompt` route (POST …/message) is RETIRED — it ran the
    // whole turn on the LEGACY engine and streamed back a SessionV1.WithParts body. Every consumer
    // rides `promptAsync` + the event stream now; the last requireLegacyCapable guard went with it.

    // Mirror the legacy catchCause: log + publish a v1 session error event so
    // unchanged clients still surface a failed async turn. Shared by both paths.
    const reportAsyncFailure = (sessionID: SessionID, cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        yield* Effect.logError("prompt_async failed", { sessionID, cause })
        yield* events.publish(Session.Event.Error, {
          sessionID,
          error: new NamedError.Unknown({ message: Cause.pretty(cause) }).toObject(),
        })
      })

    // The async V2 turn bracket shared by promptAsync/command/init: busy is published BEFORE the
    // fork so the client sees it synchronously; `resume` JOINS the live run (settles on success,
    // error, AND interrupt); `ensuring(idle)` is the SOLE turn-terminal on the V2 path — a
    // missing idle hangs the client spinner forever.
    const forkV2Turn = (sessionID: SessionID) =>
      Effect.gen(function* () {
        const v2Turn = sessionV2.resume(sessionID).pipe(
          Effect.catchCause((cause) => reportAsyncFailure(sessionID, cause)),
          Effect.ensuring(statusSvc.set(sessionID, { type: "idle" })),
        )
        yield* statusSvc.set(sessionID, { type: "busy" })
        yield* v2Turn.pipe(Effect.forkIn(scope, { startImmediately: true }))
      })

    const promptAsync = Effect.fn("SessionHttpApi.promptAsync")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof PromptPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // F1b: ONE engine — every prompt routes to the V2 native session. The old
      // reroute gate (flag + hasModel + zero-legacy-rows) is gone: legacy sessions
      // continue with NATIVE turns (their pre-F0 V1 history lapses from the default
      // native fetch — owner decision ①), and a model-less turn no longer falls back
      // to V1 — the runner surfaces the calm pre-turn Synthetic notice instead.

      // Thread the per-turn model/agent onto the session BEFORE
      // prompting so a fresh session has a model when the runner wakes
      // (BLOCKER-FIX #2). switchModel/switchAgent publish switch events that the
      // V2 runner reads; they no-op when the value already matches.
      // switchModel/switchAgent also only fail with NotFoundError (impossible
      // post-requireSession); orDie for the same reason as above.
      if (ctx.payload.model)
        yield* sessionV2
          .switchModel({
            sessionID: ctx.params.sessionID,
            // payload.model is the v1 ModelRef {providerID, modelID}; its fields
            // already carry the V2 brands. Rename modelID→id for Model.Ref.
            model: {
              id: ctx.payload.model.modelID,
              providerID: ctx.payload.model.providerID,
              ...(ctx.payload.variant ? { variant: ModelV2.VariantID.make(ctx.payload.variant) } : {}),
            },
          })
          .pipe(Effect.orDie)
      if (ctx.payload.agent)
        yield* sessionV2.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(Effect.orDie)

      const sessionID = ctx.params.sessionID
      const v2Turn = Effect.gen(function* () {
        // prompt ADMITS + WAKES (returns immediately); resume JOINS the live run
        // and settles on success, error, AND interrupt.
        // Reuse the client's message id (the desktop generates one in submit.ts and
        // sends it as payload.messageID) as the V2 prompt `id`. The translator's
        // `prompted` mapping then emits the user message under that SAME id, so it
        // reconciles with the desktop's OPTIMISTIC user bubble. Without this, V2
        // mints a fresh id and the client renders the user's prompt TWICE.
        yield* sessionV2.prompt({
          sessionID,
          ...(ctx.payload.messageID
            ? { id: ctx.payload.messageID as unknown as Parameters<typeof sessionV2.prompt>[0]["id"] }
            : {}),
          prompt: toV2Prompt(ctx.payload),
        })
        yield* sessionV2.resume(sessionID)
      }).pipe(
        Effect.catchCause((cause) => reportAsyncFailure(sessionID, cause)),
        // Load-bearing: the V2→v1 translator emits NO turn-terminal, so this
        // bracket is the SOLE busy/idle source on the V2 path. A missing idle
        // hangs the client spinner forever. ensuring fires on success/error/interrupt.
        Effect.ensuring(statusSvc.set(sessionID, { type: "idle" })),
      )
      // Publish busy BEFORE the fork so the client sees it synchronously.
      yield* statusSvc.set(sessionID, { type: "busy" })
      yield* v2Turn.pipe(Effect.forkIn(scope, { startImmediately: true }))
      return HttpApiSchema.NoContent.make()
    })

    const command = Effect.fn("SessionHttpApi.command")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof CommandPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // F1a SLICE 5 HTTP wiring (F1b: now the only path): the V2 command op (expand +
      // `` !`shell` `` substitution + subtask branch) admits the turn itself; the model turn
      // rides the forked bracket. File attachments have no V2 command lowering yet (SLICE 5
      // residue) — reject legibly instead of silently dropping a user attachment.
      if (ctx.payload.parts?.length)
        return yield* new InvalidRequestError({
          message:
            "A command with file attachments is not supported yet — send the attachment as a regular message instead.",
          kind: "native_session_op_unavailable",
        })
      // Per-turn agent/model parity with promptAsync: apply them to the session before the
      // turn (V2 persists the switch; V1's non-persisted per-turn semantics is SLICE 5 residue).
      if (ctx.payload.model) {
        const [providerID, ...rest] = ctx.payload.model.split("/")
        const modelID = rest.join("/")
        if (!providerID || !modelID) return yield* new HttpApiError.BadRequest({})
        yield* sessionV2
          .switchModel({
            sessionID: ctx.params.sessionID,
            model: {
              id: ModelV2.ID.make(modelID),
              providerID: ProviderV2.ID.make(providerID),
              ...(ctx.payload.variant ? { variant: ModelV2.VariantID.make(ctx.payload.variant) } : {}),
            },
          })
          .pipe(Effect.orDie)
      }
      if (ctx.payload.agent)
        yield* sessionV2.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(Effect.orDie)
      const result = yield* sessionV2
        .command({
          sessionID: ctx.params.sessionID,
          command: ctx.payload.command,
          arguments: ctx.payload.arguments,
          ...(ctx.payload.messageID
            ? { id: ctx.payload.messageID as unknown as Parameters<typeof sessionV2.command>[0]["id"] }
            : {}),
        })
        .pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
      // A subtask command spawned a child (surfaced via session.created events); only the
      // prompt kind runs a turn on THIS session.
      if (result.type === "prompt") yield* forkV2Turn(ctx.params.sessionID)
      return HttpApiSchema.NoContent.make()
    })

    const shell = Effect.fn("SessionHttpApi.shell")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof ShellPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      // F1a SLICE 6 HTTP wiring (F1b: now the only path): run one command to completion against
      // the session's Location; the transcript renders from the durable Shell.Started/Ended
      // events (no model turn).
      yield* sessionV2.shell({ sessionID: ctx.params.sessionID, command: ctx.payload.command }).pipe(Effect.orDie)
      return HttpApiSchema.NoContent.make()
    })

    // Revert/unrevert route to the NATIVE staged-revert (core SessionV2.revert),
    // not the legacy V1 revertSvc. The V1 service scanned the message store for
    // `part.type === "patch"` parts, which only the (deleted) V1 processor ever
    // emitted — so on a V2 session it truncated messages WITHOUT rolling back any
    // files. The native `stage` restores the working tree to each message's
    // pre-change snapshot (`snapshot.start`) and publishes RevertEvent.Staged; the
    // projector writes SessionTable.revert, which the V1 Session.Info returned below
    // reads back (one row, two schemas) — so the response contract is unchanged.
    // Message-granular only: a payload `partID` (V1 part-level revert; the app never
    // sends one) is ignored.
    const revert = Effect.fn("SessionHttpApi.revert")(function* (ctx: {
      params: { sessionID: SessionID }
      payload: typeof RevertPayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* sessionV2.revert
        .stage({ sessionID: ctx.params.sessionID, messageID: SessionMessage.ID.make(ctx.payload.messageID) })
        .pipe(
          // Reverting to a message the native engine doesn't know is a no-op that
          // returns the unchanged session (V1 parity: `if (!rev) return session`) —
          // the app only ever reverts to a real transcript message.
          Effect.catchTag("Session.MessageNotFoundError", () => Effect.void),
          Effect.orDie,
        )
      return yield* requireSession(ctx.params.sessionID)
    })

    const unrevert = Effect.fn("SessionHttpApi.unrevert")(function* (ctx: { params: { sessionID: SessionID } }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* sessionV2.revert.clear(ctx.params.sessionID).pipe(Effect.orDie)
      return yield* requireSession(ctx.params.sessionID)
    })

    const permissionRespond = Effect.fn("SessionHttpApi.permissionRespond")(function* (ctx: {
      params: { sessionID: SessionID; permissionID: PermissionV1.ID }
      payload: typeof PermissionResponsePayload.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* permissionSvc.reply({ requestID: ctx.params.permissionID, reply: ctx.payload.response }).pipe(
        Effect.catchTag("Permission.NotFoundError", (error) =>
          Effect.fail(
            new PermissionNotFoundError({
              requestID: String(error.requestID),
              message: `Permission request not found: ${error.requestID}`,
            }),
          ),
        ),
      )
      return true
    })

    const deleteMessage = Effect.fn("SessionHttpApi.deleteMessage")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* SessionError.mapBusy(runState.assertNotBusy(ctx.params.sessionID))
      yield* session.removeMessage(ctx.params)
      return true
    })

    const deletePart = Effect.fn("SessionHttpApi.deletePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
    }) {
      yield* requireSession(ctx.params.sessionID)
      yield* session.removePart(ctx.params)
      return true
    })

    const updatePart = Effect.fn("SessionHttpApi.updatePart")(function* (ctx: {
      params: { sessionID: SessionID; messageID: MessageID; partID: PartID }
      payload: typeof SessionV1.Part.Type
    }) {
      yield* requireSession(ctx.params.sessionID)
      const payload = ctx.payload as SessionV1.Part
      if (
        payload.id !== ctx.params.partID ||
        payload.messageID !== ctx.params.messageID ||
        payload.sessionID !== ctx.params.sessionID
      ) {
        return yield* new HttpApiError.BadRequest({})
      }
      return yield* session.updatePart(payload)
    })

    return handlers
      .handle("list", list)
      .handle("status", status)
      .handle("get", get)
      .handle("children", children)
      .handle("todo", todo)
      .handle("diff", diff)
      .handle("messages", messages)
      .handle("message", message)
      .handleRaw("create", createRaw)
      .handle("remove", remove)
      .handle("update", update)
      .handleRaw("fork", forkRaw)
      .handle("abort", abort)
      .handle("init", init)
      .handle("share", share)
      .handle("unshare", unshare)
      .handle("summarize", summarize)
      .handle("promptAsync", promptAsync)
      .handle("command", command)
      .handle("shell", shell)
      .handle("revert", revert)
      .handle("unrevert", unrevert)
      .handle("permissionRespond", permissionRespond)
      .handle("deleteMessage", deleteMessage)
      .handle("deletePart", deletePart)
      .handle("updatePart", updatePart)
  }),
)
