import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { NamedError } from "@novaclaw/core/util/error"
import { SessionInput } from "@novaclaw/core/session/input"
import { Database } from "@novaclaw/core/database/database"
import { SessionTags } from "@novaclaw/core/session/tags"
import { AgentV2 } from "@novaclaw/core/agent"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { DateTime, Effect, Stream } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"
import { SessionsCursor } from "@novaclaw/protocol/groups/session"
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

const DefaultSessionsLimit = 50
const DefaultSessionHistoryLimit = 50

export const SessionHandler = HttpApiBuilder.group(Api, "server.session", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    const tags = yield* SessionTags.Service

    return handlers
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
          const sessions = yield* session.list({
            ...query,
            workspaceID: query.workspace,
            limit: ctx.query.limit ?? DefaultSessionsLimit,
          })
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
            data: yield* session.create({
              id: ctx.payload.id,
              parentID: ctx.payload.parentID,
              agent: ctx.payload.agent,
              model: ctx.payload.model,
              systemPromptOverride: ctx.payload.systemPromptOverride,
              type: ctx.payload.type,
              priority: ctx.payload.priority,
              permissionMode: ctx.payload.permissionMode,
              title: ctx.payload.title,
              permission: ctx.payload.permission,
              strict: ctx.payload.strict,
              introspection: ctx.payload.introspection,
              quality: ctx.payload.quality,
              affective: ctx.payload.affective,
              location: ctx.payload.location ?? { directory: AbsolutePath.make(process.cwd()) },
            }),
          }
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
            new SessionNotFoundError({
              sessionID: error.sessionID,
              message: `Session not found: ${error.sessionID}`,
            })
          if (ctx.payload.title !== undefined)
            yield* session
              .setTitle({ sessionID: ctx.params.sessionID, title: ctx.payload.title })
              .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
          if (ctx.payload.metadata !== undefined)
            yield* session
              .setMetadata({ sessionID: ctx.params.sessionID, metadata: ctx.payload.metadata })
              .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
          if (ctx.payload.archived !== undefined)
            yield* session
              .setArchived({
                sessionID: ctx.params.sessionID,
                // null on the wire = unarchive (the core op takes undefined for restore)
                ...(ctx.payload.archived === null ? {} : { time: ctx.payload.archived }),
              })
              .pipe(Effect.catchTag("Session.NotFoundError", (error) => notFound(error)))
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
          yield* session
            .switchResponder({ sessionID: ctx.params.sessionID, responder: ctx.payload.responder })
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
          yield* session
            .shell({ sessionID: ctx.params.sessionID, command: ctx.payload.command })
            .pipe(
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
                return Effect.logError("failed to stage session revert", { cause: error }).pipe(
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({
                        message: NamedError.internalMessage(ref),
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
              return Effect.logError("failed to clear session revert", { cause: error }).pipe(
                Effect.andThen(
                  Effect.fail(
                    new UnknownError({
                      message: NamedError.internalMessage(ref),
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
                return Effect.logError("failed to decode session message").pipe(
                  Effect.annotateLogs({ ref, sessionID: error.sessionID, messageID: error.messageID }),
                  Effect.andThen(
                    Effect.fail(
                      new UnknownError({ message: NamedError.internalMessage(ref), ref }),
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
              Effect.map((page) => ({
                data: page.events,
                hasMore: page.hasMore,
              })),
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
)
