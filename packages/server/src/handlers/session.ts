import { Location } from "@novaclaw/core/location"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { NamedError } from "@novaclaw/core/util/error"
import { SessionInput } from "@novaclaw/core/session/input"
import { Database } from "@novaclaw/core/database/database"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { SessionLocationRecovery } from "@novaclaw/core/session/location-recovery"
import { SessionTags } from "@novaclaw/core/session/tags"
import { SessionPresence } from "@novaclaw/core/session/presence"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentWorkspace } from "@novaclaw/core/agent/workspace"
import { Scratch } from "@novaclaw/core/scratch"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { DateTime, Effect, Layer, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { SessionCatalogApi, SessionControlApi, SessionObservationApi, SessionRuntimeApi } from "../handler-api-session"
import { handlerLayer } from "../handler-api"
import { SessionHistoryResponse, SessionsCursor } from "@novaclaw/protocol/groups/session"
import {
  ConflictError,
  InvalidCursorError,
  InvalidRequestError,
  MessageNotFoundError,
  ServiceUnavailableError,
  SessionNotFoundError,
  UnknownError,
} from "@novaclaw/protocol/errors"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Log } from "@novaclaw/schema/log"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionReceipt } from "@novaclaw/core/session/receipt"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { resolveConfigView } from "./session-config"

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

const SessionCatalogHandler = handlerLayer(
  HttpApiBuilder.group(SessionCatalogApi, "server.session.catalog", (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const tags = yield* SessionTags.Service
      const attempts = yield* SessionExecutionAttempt.Service
      const receipts = yield* SessionReceipt.Service
      const presence = yield* SessionPresence.Service
      const execution = yield* SessionExecution.Service
      const effective = yield* SessionEffectiveConfig.Service
      const components = yield* SessionComponentRegistry.Service

      return (
        handlers
          .handle(
            "session.tags.set",
            Effect.fn(function* (ctx) {
              yield* tags.set(ctx.params.sessionID, ctx.payload.tags)
              return HttpApiSchema.NoContent.make()
            }),
          )
          .handle(
            "session.tags.all",
            Effect.fn(function* () {
              return { data: yield* tags.all() }
            }),
          )
          .handle(
            "session.list",
            Effect.fn(function* (ctx) {
              const query =
                ctx.query.cursor !== undefined
                  ? yield* SessionsCursor.parse(ctx.query.cursor).pipe(
                      Effect.mapError(() => new InvalidCursorError({ message: "Invalid cursor" })),
                    )
                  : ctx.query
              const listed = yield* session.list({
                ...query,
                workspaceID: query.workspace,
                limit: ctx.query.limit ?? DefaultSessionsLimit,
              })
              // The debug roster is an OS diagnostic, so raw sparse rows are not enough: a child
              // with an inherited officer/model would appear ownerless even while it is running
              // under that effective identity. Resolve the same parent-chain config the runner uses
              // and overlay only the two displayed identity fields; everything else remains the
              // authoritative session row.
              const sessions = yield* Effect.forEach(
                listed,
                (item) =>
                  effective.resolve(item.id).pipe(
                  Effect.map((config) => ({
                      ...item,
                      ...(config.agent === undefined ? {} : { agent: AgentV2.ID.make(config.agent) }),
                      ...(config.model === undefined
                        ? {}
                        : {
                            model: ModelV2.Ref.make({
                              providerID: ProviderV2.ID.make(config.model.providerID),
                              id: ModelV2.ID.make(config.model.id),
                              ...(config.model.variant === undefined
                                ? {}
                                : { variant: ModelV2.VariantID.make(config.model.variant) }),
                            }),
                          }),
                  })),
                  ),
                { concurrency: 4 },
              )
              const first = sessions[0]
              const last = sessions.at(-1)
              return {
                data: sessions,
                cursor: {
                  previous: first
                    ? SessionsCursor.make({
                        ...query,
                        anchor: {
                          id: first.id,
                          time: DateTime.toEpochMillis(first.time.created),
                          direction: "previous",
                        },
                      })
                    : undefined,
                  next: last
                    ? SessionsCursor.make({
                        ...query,
                        anchor: {
                          id: last.id,
                          time: DateTime.toEpochMillis(last.time.created),
                          direction: "next",
                        },
                      })
                    : undefined,
                },
              }
            }),
          )
          .handle(
            "session.create",
            Effect.fn(function* (ctx) {
              return {
                data: yield* createWithOwner(session, {
                  id: ctx.payload.id,
                  parentID: ctx.payload.parentID,
                  agent: ctx.payload.agent,
                  model: ctx.payload.model,
                  // A Device PIN, validated against the resolved model immediately before provider
                  // dispatch. `undefined` still means INHERIT, so coalescing it to a derived key here
                  // would stamp one session's backend onto every child it ever spawns.
                  device: ctx.payload.device,
                  controlBinding: ctx.payload.controlBinding,
                  systemPromptOverride: ctx.payload.systemPromptOverride,
                  type: ctx.payload.type,
                  priority: ctx.payload.priority,
                  permissionMode: ctx.payload.permissionMode,
                  responder: ctx.payload.responder,
                  title: ctx.payload.title,
                  strict: ctx.payload.strict,
                  // ⚠️ The per-session feature overrides are forwarded ONE-FOR-ONE with
                  // `SessionFeature.Name`, and a plain `ctx.payload.<name>` is deliberate: each is a
                  // TRI-STATE where `undefined` means INHERIT. Never coalesce one to a boolean here
                  // (`?? false` and friends) — `createSessionRecord` writes exactly what it is handed,
                  // so a coalesced default would stamp a stance into every new session's row and, for
                  // the three narrowing switches, hand a fork of a restricted parent LESS restriction
                  // than its source (ruling 8).
                  //
                  // This list was the SECOND of three places a draft's restrictions were dropped (the
                  // payload schema and `app/.../prompt-input/submit.ts` were the others): it carried
                  // only the first three until 2026-07-31, so `thinkingBudget`, `surgicalEdits`,
                  // `askBeforeChanges` and `safeMode` never reached the kernel, which had accepted all
                  // seven since 2026-07-29. Pinned by `./session-create-features.test.ts`.
                  introspection: ctx.payload.introspection,
                  quality: ctx.payload.quality,
                  affective: ctx.payload.affective,
                  thinkingBudget: ctx.payload.thinkingBudget,
                  surgicalEdits: ctx.payload.surgicalEdits,
                  askBeforeChanges: ctx.payload.askBeforeChanges,
                  safeMode: ctx.payload.safeMode,
                  contextBudget: ctx.payload.contextBudget,
                  memory: ctx.payload.memory,
                  shortChat: ctx.payload.shortChat,
                  // 🔴 **Was `?? { directory: AbsolutePath.make(process.cwd()) }`** — the SERVER
                  // PROCESS's directory, not the one the request named. `list` honours the request's
                  // location, so a create-then-list in one breath returned NOTHING, and the create
                  // response was not even wrong: it faithfully reported the directory it had used.
                  // `process.cwd()` is only ever right for a CLI; on the shipped headless/remote path
                  // it filed every session where `list` would never look again.
                  //
                  // ⚠️ `Location.Service` is resolvable here ONLY because `session.create` now declares
                  // `locationMiddleware` (see `protocol/groups/session.ts`). Resolving a service that no
                  // middleware provides typechecks and then fails on every request — measured: this exact
                  // line returned 500 on every create before the endpoint carried the middleware.
                  // 🔴 An AGENT names its own folder (owner, 2026-08-21: *"the folder an agent works
                  // on is now part of its configuration"*). With no explicit location, a create FOR A
                  // COLLEAGUE lands in that colleague's project — or in its own scratch when it has
                  // none — so the prompt area can ask which colleague and never which folder.
                  //
                  // ⚠️ Resolved HERE rather than in the client. The client would have to join
                  // `<scratchRoot>/<agentID>` itself, which means a path separator decision on the
                  // wrong side of the wire and a second copy of a rule that already exists in
                  // `AgentWorkspace.folderFor`.
                  location: ctx.payload.location ?? (yield* agentLocation(ctx.payload.agent)),
                }),
              }
            }),
          )
          .handle(
            "session.presence.report",
            Effect.fn(function* (ctx) {
              const { viewerID, kind, label, writing, action } = ctx.payload
              // The session's existence is already proven by `sessionLocationMiddleware` (404 before
              // we get here), so an unknown id can never mint a presence room.
              if (action === "claim") return { data: yield* presence.claim(ctx.params.sessionID, viewerID) }
              if (action === "detach") return { data: yield* presence.detach(ctx.params.sessionID, viewerID) }
              return {
                data: yield* presence.report(ctx.params.sessionID, {
                  viewerID,
                  kind,
                  label,
                  ...(writing === undefined ? {} : { writing }),
                }),
              }
            }),
          )
          .handle(
            "session.presence.all",
            Effect.fn(function* () {
              return { data: yield* presence.all() }
            }),
          )
          .handle(
            "session.active",
            Effect.fn(function* () {
              return {
                data: Object.fromEntries(
                  Array.from(yield* session.active, (sessionID) => [sessionID, { type: "running" as const }]),
                ),
              }
            }),
          )
          .handle(
            "session.execution.list",
            Effect.fn(function* (ctx) {
              if (ctx.query.sessionID !== undefined) {
                const found = yield* attempts.get(ctx.query.sessionID)
                return { data: found === undefined ? [] : [found] }
              }
              return { data: yield* attempts.list() }
            }),
          )
          .handle(
            "session.receipt",
            Effect.fn(function* (ctx) {
              const found = yield* receipts.forSession(ctx.params.sessionID)
              // ⚠️ 404, not an empty receipt. An empty one asserts that nothing happened, which is a
              // different claim from "this session has not run yet" — and a caller cannot tell them
              // apart once they are spelled the same.
              if (!found)
                return yield* new SessionNotFoundError({
                  sessionID: ctx.params.sessionID,
                  message: `No attempt has run for session ${ctx.params.sessionID}, so there is no receipt`,
                })
              return { data: found }
            }),
          )
          .handle(
            "session.get",
            Effect.fn(function* (ctx) {
              return {
                data: yield* session.get(ctx.params.sessionID).pipe(
                  Effect.catchTag(
                    "Session.NotFoundError",
                    (error) =>
                      new SessionNotFoundError({
                        sessionID: error.sessionID,
                        message: `Session not found: ${error.sessionID}`,
                      }),
                  ),
                ),
              }
            }),
          )
          // v0.2.0 batch 4.4 — the resolved-config view. See `./session-config.ts` for why the shape is
          // generated from `SESSION_CONFIG_FIELDS` rather than written out here.
          .handle(
            "session.config",
            Effect.fn(function* (ctx) {
              // Resolve the target FIRST so a session that does not exist 404s. Without this the walk
              // would answer "every field is at its default" for an id that names nothing — ruling 2's
              // *a fault is never described falsely*, and the most misleading possible answer from an
              // endpoint whose whole job is telling you where a value came from.
              yield* session.get(ctx.params.sessionID).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              )
              // The layer the TURN resolves against, from the one place the folder's tune is folded
              // in. Passing the shipped defaults here (what this handler did until 2026-08-13) made
              // every `source` say `instance`, including for values a `novaclaw.json` supplied —
              // the endpoint answering its own question wrongly rather than not at all.
              const layer = yield* effective.resolution(ctx.params.sessionID)
              return {
                data: yield* resolveConfigView(
                  ctx.params.sessionID,
                  (id) =>
                    // The same feeder the runner passes to `resolveSessionConfig`: a missing row is
                    // `undefined`, which the walk reads as "the chain ends here".
                    session
                      .get(id as SessionSchema.ID)
                      .pipe(Effect.catchTag("Session.NotFoundError", () => Effect.succeed(undefined))),
                  {
                    defaults: layer.defaults,
                    // WHO chose each default. Without it every colleague-declared field reported
                    // `source: {kind: "instance"}` by elimination — see `AgentLayer`.
                    ...(layer.agent === undefined ? {} : { agent: layer.agent }),
                    ...(layer.project === undefined
                      ? {}
                      : {
                          project: {
                            root: layer.project.root,
                            file: layer.project.file,
                            applied: layer.applied,
                            refused: layer.refused,
                          },
                        }),
                  },
                ),
              }
            }),
          )
          // V1-nuke A0: native twins of the last live bare-/session operations. Same core ops the V1
          // handlers routed to; the wire shape is the native Session.Info.
          .handle(
            "session.children",
            Effect.fn(function* (ctx) {
              return {
                data: yield* session.children(ctx.params.sessionID).pipe(
                  Effect.catchTag(
                    "Session.NotFoundError",
                    (error) =>
                      new SessionNotFoundError({
                        sessionID: error.sessionID,
                        message: `Session not found: ${error.sessionID}`,
                      }),
                  ),
                ),
              }
            }),
          )
          .handle(
            "session.update",
            Effect.fn(function* (ctx) {
              const notFound = (error: { sessionID: string }) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                )
              // Component writers validate their own values, not entity existence. Preserve the
              // update route's 404 contract before touching the sparse Device component.
              if (ctx.payload.device !== undefined)
                yield* session
                  .get(ctx.params.sessionID)
                  .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
              if (ctx.payload.title !== undefined)
                yield* session
                  .setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
                  .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
              if (ctx.payload.metadata !== undefined)
                yield* session
                  .setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
                  .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
              if (ctx.payload.archived !== undefined)
                if (ctx.payload.archived === null) {
                  const current = yield* session.get(ctx.params.sessionID).pipe(
                    Effect.catchTag("Session.NotFoundError", notFound),
                  )
                  const agent = current.agent
                  if (agent === undefined || AgentV2.POSTURE_IDS.has(agent))
                    return yield* new InvalidRequestError({
                      message: "Only an officer's canonical chat can be restored.",
                      kind: "session_restore_unavailable",
                    })
                  const officer = yield* AgentV2.Service.use((service) => service.get(agent))
                  if (officer === undefined)
                    return yield* new InvalidRequestError({
                      message: `Cannot restore ${ctx.params.sessionID}: officer ${agent} is retired.`,
                      kind: "session_restore_unavailable",
                    })
                  yield* session.restore({ sessionID: ctx.params.sessionID, agent }).pipe(
                    Effect.catchTag("Session.NotFoundError", notFound),
                    Effect.catchTag("Session.RestoreUnavailableError", (error) =>
                      Effect.fail(
                        new InvalidRequestError({
                          message: error.reason,
                          kind: "session_restore_unavailable",
                        }),
                      ),
                    ),
                  )
                } else
                  yield* session
                    .setArchived({ sessionID: ctx.params.sessionID, time: ctx.payload.archived })
                    .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
              if (ctx.payload.device === null)
                yield* components.remove({ sessionID: ctx.params.sessionID, kind: "device" }).pipe(
                  Effect.mapError(
                    (error) =>
                      new InvalidRequestError({
                        message: `Could not update this chat's Device pin: ${error.message}`,
                      }),
                  ),
                )
              else if (ctx.payload.device !== undefined)
                yield* components
                  .put({ sessionID: ctx.params.sessionID, kind: "device", value: ctx.payload.device })
                  .pipe(
                    Effect.mapError(
                      (error) =>
                        new InvalidRequestError({
                          message: `Could not update this chat's Device pin: ${error.message}`,
                        }),
                    ),
                  )
              return {
                data: yield* session
                  .get(ctx.params.sessionID)
                  .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error))),
              }
            }),
          )
          .handle(
            "session.remove",
            Effect.fn(function* (ctx) {
              yield* session.remove(ctx.params.sessionID).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              )
              return HttpApiSchema.NoContent.make()
            }),
          )
          .handle(
            "session.fork",
            Effect.fn(function* (ctx) {
              return {
                data: yield* session
                  .fork({
                    sessionID: ctx.params.sessionID,
                    messageID: ctx.query.messageID,
                  })
                  .pipe(
                    Effect.catchTag(
                      "Session.NotFoundError",
                      (error) =>
                        new SessionNotFoundError({
                          sessionID: error.sessionID,
                          message: `Session not found: ${error.sessionID}`,
                        }),
                    ),
                    Effect.catchTag(
                      "Session.MessageNotFoundError",
                      (error) =>
                        new MessageNotFoundError({
                          sessionID: ctx.params.sessionID,
                          messageID: error.messageID,
                          message: `Message not found: ${error.messageID}`,
                        }),
                    ),
                    // A stored message that fails to decode is corrupt state, not a client error.
                    Effect.catchTag("Session.MessageDecodeError", (error) => Effect.die(error)),
                  ),
              }
            }),
          )
      )
    }),
  ),
)

const SessionControlHandler = handlerLayer(
  HttpApiBuilder.group(SessionControlApi, "server.session.control", (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      return handlers
        .handle(
          "session.pending",
          Effect.fn(function* (ctx) {
            const { db } = yield* Database.Service
            const rows = yield* SessionInput.listPending(db, ctx.params.sessionID)
            return {
              data: rows.map((row) => ({
                id: row.id,
                // The transcript shows text; attachments are not worth surfacing on a queued bubble.
                text: row.prompt.text,
                delivery: String(row.delivery),
                timeCreated: row.timeCreated,
              })),
            }
          }),
        )
        .handle(
          "session.todo",
          Effect.fn(function* (ctx) {
            return {
              data: yield* session.todos(ctx.params.sessionID).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              ),
            }
          }),
        )
        .handle(
          "session.switchAgent",
          Effect.fn(function* (ctx) {
            yield* session.switchAgent({ sessionID: ctx.params.sessionID, agent: ctx.payload.agent }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              // One chat per colleague. 409, and it names WHICH colleague and WHY — a bare conflict
              // sends the caller looking for a race that did not happen.
              Effect.catchTag("Session.OperationUnavailableError", () =>
                Effect.fail(
                  new ConflictError({
                    message:
                      `${ctx.payload.agent} already has a chat. A colleague has exactly one, so this ` +
                      `session cannot be switched onto them — open their existing chat instead.`,
                    resource: `agent:${ctx.payload.agent}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchModel",
          Effect.fn(function* (ctx) {
            yield* session.switchModel({ sessionID: ctx.params.sessionID, model: ctx.payload.model }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchResponder",
          Effect.fn(function* (ctx) {
            yield* session.switchResponder({ sessionID: ctx.params.sessionID, responder: ctx.payload.responder }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchStrict",
          Effect.fn(function* (ctx) {
            yield* session.switchStrict({ sessionID: ctx.params.sessionID, strict: ctx.payload.strict }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchFeature",
          Effect.fn(function* (ctx) {
            yield* session
              .switchFeature({
                sessionID: ctx.params.sessionID,
                feature: ctx.payload.feature,
                enabled: ctx.payload.enabled,
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
              )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchType",
          Effect.fn(function* (ctx) {
            yield* session.switchType({ sessionID: ctx.params.sessionID, type: ctx.payload.type }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchPromptOverride",
          Effect.fn(function* (ctx) {
            yield* session
              .switchPromptOverride({ sessionID: ctx.params.sessionID, override: ctx.payload.override })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
              )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.folder",
          Effect.fn(function* (ctx) {
            const info = yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
            const { db } = yield* Database.Service
            const missing = yield* SessionLocationRecovery.get(db, ctx.params.sessionID)
            return {
              data: {
                directory: info.location.directory,
                // Omitted rather than sent as null: an absent key is "nothing was lost", which is
                // the overwhelmingly common answer and should not read as an unknown.
                ...(missing === undefined ? {} : { missing }),
              },
            }
          }),
        )
        .handle(
          "session.repointFolder",
          // Written through the component registry rather than by patching the row, so this endpoint
          // and an agent moving its own folder are the SAME operation: one validation
          // (`resolveWorkingFolder`), one `Moved` event, one place that re-derives project identity
          // and clears the recorded missing-folder recovery. A second write path here would be a
          // second set of those rules to keep in step.
          Effect.fn(function* (ctx) {
            const components = yield* SessionComponentRegistry.Service
            // Existence is checked HERE rather than read out of the registry's failure, because the
            // registry collapses "no such session" and "that folder is not allowed" into one
            // `InvalidValue`. Answering 404 off a string match, or 400 for a session that does not
            // exist, would both describe the fault falsely (ruling 2) — so the one case that has a
            // distinct HTTP meaning is established before the write.
            yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
            yield* components
              .put({ sessionID: ctx.params.sessionID, kind: "working_folder", value: ctx.payload.directory })
              .pipe(
                // Everything else the registry can refuse is a bad REQUEST and says why in its own
                // words: a path that does not resolve, or a destination in a different project (the
                // kernel keeps a session inside the project it was created in).
                Effect.catch((error: { readonly message?: string }) =>
                  Effect.fail(
                    new InvalidRequestError({
                      message: `Cannot point this session at ${ctx.payload.directory}: ${error.message ?? "rejected"}`,
                    }),
                  ),
                ),
              )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.switchMode",
          Effect.fn(function* (ctx) {
            yield* session
              .switchMode({ sessionID: ctx.params.sessionID, permissionMode: ctx.payload.permissionMode })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
              )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.shell",
          Effect.fn(function* (ctx) {
            yield* session.shell({ sessionID: ctx.params.sessionID, command: ctx.payload.command }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.orDie,
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.command",
          Effect.fn(function* (ctx) {
            // Per-turn agent/model selection persists on the session (V2 switch semantics), then the
            // core command op expands + dispatches (it admits + wakes the turn itself; a subtask
            // command spawns a child surfaced via session events).
            if (ctx.payload.model !== undefined) {
              const [providerID, ...rest] = ctx.payload.model.split("/")
              const modelID = rest.join("/")
              if (!providerID || !modelID)
                return yield* new InvalidRequestError({ message: `Invalid model ref: ${ctx.payload.model}` })
              yield* session
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
            if (ctx.payload.agent !== undefined)
              yield* session
                .switchAgent({ sessionID: ctx.params.sessionID, agent: AgentV2.ID.make(ctx.payload.agent) })
                .pipe(Effect.orDie)
            yield* session
              .command({
                sessionID: ctx.params.sessionID,
                command: ctx.payload.command,
                arguments: ctx.payload.arguments,
                ...(ctx.payload.messageID ? { id: SessionMessage.ID.make(ctx.payload.messageID) } : {}),
              })
              .pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catch((error: unknown) =>
                  Effect.fail(
                    error instanceof SessionNotFoundError ? error : new InvalidRequestError({ message: String(error) }),
                  ),
                ),
              )
            return HttpApiSchema.NoContent.make()
          }),
        )
    }),
  ),
)

const SessionRuntimeHandler = handlerLayer(
  HttpApiBuilder.group(SessionRuntimeApi, "server.session.runtime", (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      return handlers
        .handle(
          "session.prompt",
          Effect.fn(function* (ctx) {
            return {
              data: yield* session
                .prompt({
                  sessionID: ctx.params.sessionID,
                  id: ctx.payload.id,
                  prompt: ctx.payload.prompt,
                  delivery: ctx.payload.delivery,
                  resume: ctx.payload.resume,
                })
                .pipe(
                  Effect.catchTag("Session.NotFoundError", (error) =>
                    Effect.fail(
                      new SessionNotFoundError({
                        sessionID: error.sessionID,
                        message: `Session not found: ${error.sessionID}`,
                      }),
                    ),
                  ),
                  Effect.catchTag("Session.PromptConflictError", (error) =>
                    Effect.fail(
                      new ConflictError({
                        message: `Prompt message ID conflicts with an existing durable record: ${error.messageID}`,
                        resource: error.messageID,
                      }),
                    ),
                  ),
                  // 🔴 A filed chat refuses work, and the refusal NAMES WHERE IT SHOULD HAVE GONE.
                  // `ConflictError` is the honest wire shape: the resource is in a state that refuses
                  // this operation, which is exactly true of a conversation that has been archived.
                  // `resource` carries the successor so a caller can retry there without parsing prose
                  // — and when the colleague has no live chat (a retirement), it carries the archived
                  // id and the sentence says there is nowhere to go, rather than inventing one.
                  Effect.catchTag("Session.ArchivedError", (error) =>
                    Effect.fail(
                      new ConflictError({
                        message: error.successorID
                          ? `This conversation has been filed and does not take new messages. Its colleague's current chat is ${error.successorID}.`
                          : `This conversation has been filed and does not take new messages, and its colleague has no current chat.`,
                        resource: error.successorID ?? error.sessionID,
                      }),
                    ),
                  ),
                ),
            }
          }),
        )
        .handle(
          "session.compact",
          Effect.fn(function* (ctx) {
            yield* session.compact({ sessionID: ctx.params.sessionID }).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.OperationUnavailableError", (error) =>
                Effect.fail(
                  new ServiceUnavailableError({
                    message: `Session ${error.operation} is not available yet`,
                    service: `session.${error.operation}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.wait",
          Effect.fn(function* (ctx) {
            yield* session.wait(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
              Effect.catchTag("Session.OperationUnavailableError", (error) =>
                Effect.fail(
                  new ServiceUnavailableError({
                    message: `Session ${error.operation} is not available yet`,
                    service: `session.${error.operation}`,
                  }),
                ),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.revert.stage",
          Effect.fn(function* (ctx) {
            return {
              data: yield* session.revert.stage({ ...ctx.params, ...ctx.payload }).pipe(
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
                Effect.catchTag(
                  "Session.MessageNotFoundError",
                  (error) =>
                    new MessageNotFoundError({
                      sessionID: error.sessionID,
                      messageID: error.messageID,
                      message: `Message not found: ${error.messageID}`,
                    }),
                ),
                Effect.catchTag("Snapshot.Error", (error) => {
                  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                  return Log.event("session.revert.stage.failed", {
                    "session.id": ctx.params.sessionID,
                    "session.ref": ref,
                    "snapshot.operation": error.operation,
                    "snapshot.error": Log.fault(error),
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new UnknownError({
                          message: NamedError.internalMessage(
                            ref,
                            "NovaClaw could not prepare the requested session rollback.",
                          ),
                          ref,
                        }),
                      ),
                    ),
                  )
                }),
              ),
            }
          }),
        )
        .handle(
          "session.revert.clear",
          Effect.fn(function* (ctx) {
            yield* session.revert.clear(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
              Effect.catchTag("Snapshot.Error", (error) => {
                const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                return Log.event("session.revert.clear.failed", {
                  "session.id": ctx.params.sessionID,
                  "session.ref": ref,
                  "snapshot.operation": error.operation,
                  "snapshot.error": Log.fault(error),
                }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: NamedError.internalMessage(
                          ref,
                          "NovaClaw could not clear the pending session rollback.",
                        ),
                        ref,
                      }),
                    ),
                  ),
                )
              }),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.revert.commit",
          Effect.fn(function* (ctx) {
            yield* session.revert.commit(ctx.params.sessionID).pipe(
              Effect.catchTag(
                "Session.NotFoundError",
                (error) =>
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
    }),
  ),
)

const SessionObservationHandler = handlerLayer(
  HttpApiBuilder.group(SessionObservationApi, "server.session.observation", (handlers) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const attempts = yield* SessionExecutionAttempt.Service
      const execution = yield* SessionExecution.Service
      const events = yield* EventV2.Service

      return handlers
        .handle(
          "session.context",
          Effect.fn(function* (ctx) {
            return {
              data: yield* session.context(ctx.params.sessionID).pipe(
                Effect.catchTag("Session.NotFoundError", (error) =>
                  Effect.fail(
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                  ),
                ),
                Effect.catchTag("Session.MessageDecodeError", (error) => {
                  const ref = `err_${crypto.randomUUID().slice(0, 8)}`
                  return Log.event("session.message.decode.failed", {
                    "session.id": error.sessionID,
                    "session.message": error.messageID,
                    "session.ref": ref,
                  }).pipe(
                    Effect.andThen(
                      Effect.fail(
                        new UnknownError({
                          message: NamedError.internalMessage(
                            ref,
                            "NovaClaw could not read one saved message in this chat.",
                          ),
                          ref,
                        }),
                      ),
                    ),
                  )
                }),
              ),
            }
          }),
        )
        .handle(
          "session.history",
          Effect.fn(function* (ctx) {
            return yield* session
              .history({
                sessionID: ctx.params.sessionID,
                after: ctx.query.after,
                limit: ctx.query.limit ?? DefaultSessionHistoryLimit,
              })
              .pipe(
                Effect.map(
                  (page) =>
                    new SessionHistoryResponse({
                      data: page.events,
                      hasMore: page.hasMore,
                    }),
                ),
                Effect.catchTag(
                  "Session.NotFoundError",
                  (error) =>
                    new SessionNotFoundError({
                      sessionID: error.sessionID,
                      message: `Session not found: ${error.sessionID}`,
                    }),
                ),
              )
          }),
        )
        .handle(
          "session.events",
          Effect.fn((ctx) =>
            Effect.succeed(
              session.events({ sessionID: ctx.params.sessionID, after: ctx.query.after }).pipe(Stream.orDie),
            ),
          ),
        )
        .handle(
          "session.interrupt",
          Effect.fn(function* (ctx) {
            yield* session.interrupt(ctx.params.sessionID)
            const reason = ctx.payload.reason?.trim()
            if (reason) {
              const timestamp = yield* DateTime.now
              yield* events.publish(SessionEvent.Synthetic, {
                sessionID: ctx.params.sessionID,
                messageID: SessionMessage.ID.create(),
                timestamp,
                text: `You stopped the running command: ${reason}`,
              })
            }
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.execution.retry",
          Effect.fn(function* (ctx) {
            yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
                ),
              ),
            )
            yield* attempts.authorizeRetry(ctx.params.sessionID)
            yield* execution.resume(ctx.params.sessionID).pipe(Effect.orDie)
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "session.message",
          Effect.fn(function* (ctx) {
            const message = yield* session.message(ctx.params)
            if (message) return { data: message }
            return yield* new MessageNotFoundError({
              sessionID: ctx.params.sessionID,
              messageID: ctx.params.messageID,
              message: `Message not found: ${ctx.params.messageID}`,
            })
          }),
        )
    }),
  ),
)

/**
 * Where a new chat for `agentID` should run: the colleague's configured project, or its own scratch.
 *
 * Falls back to the REQUEST's location when there is no agent, or when the agent has no row yet —
 * the pre-existing behaviour, and the right one: a create that names nobody is the caller's own
 * directory, and inventing a scratch folder for an id that does not exist would file the session
 * somewhere the user could not find it.
 */
const agentLocation = (agentID: string | undefined) =>
  Effect.gen(function* () {
    const requested = {
      directory: (yield* Location.Service).directory,
      workspaceID: (yield* Location.Service).workspaceID,
    }
    if (agentID === undefined || agentID === "") return requested
    /**
     * ⚠️ A POSTURE has no folder of its own, and this became load-bearing when NC-SEC-020 made every
     * root name an agent. `build` and `plan` say HOW a chat runs, not WHOSE it is — there is no
     * colleague whose project or scratch this could mean. Without this line every create that did
     * not carry an explicit location silently landed in `…/scratch/build` instead of the directory
     * the request came from, which is the same location-inheritance surprise that made `novaclaw
     * run` look like it was hanging (NC-CS-002).
     */
    if (AgentV2.POSTURE_IDS.has(agentID)) return requested
    const agent = yield* AgentV2.Service.use((service) => service.get(AgentV2.ID.make(agentID)))
    if (agent === undefined) return requested
    // Read straight off `Agent.Info`, which has declared `directory` since this was written; the cast
    // it used to go through predated that and hid the field's real type.
    const folder = AgentWorkspace.folderFor({ agentID, directory: agent.directory })
    // The colleague's own scratch may not exist yet — a first chat for a newly hired officer is the
    // ordinary case. Creating it here keeps "every agent always has a real folder" true rather than
    // aspirational; a failure falls back rather than refusing the create.
    yield* Effect.promise(() => Scratch.ensureForAgent(agentID, agent.name ?? agentID)).pipe(Effect.ignore)
    return { directory: AbsolutePath.make(folder), workspaceID: requested.workspaceID }
  })

/**
 * `session.create`, with NC-SEC-020's refusal translated for the wire.
 *
 * ⚠️ A caller mistake with a correct action attached — name the agent — so it becomes an
 * `InvalidRequestError` (a 400) rather than a defect. The kernel raises it only for a ROOT; a child
 * may still omit `agent`, where the absence means *inherit from the parent*.
 */
const createWithOwner = (session: SessionV2.Interface, input: Parameters<SessionV2.Interface["create"]>[0]) =>
  session
    .create(input)
    .pipe(Effect.catchTag("Session.OwnerRequiredError", (error) => new InvalidRequestError({ message: error.reason })))

export const SessionHandler = Layer.mergeAll(
  SessionCatalogHandler,
  SessionControlHandler,
  SessionRuntimeHandler,
  SessionObservationHandler,
)
