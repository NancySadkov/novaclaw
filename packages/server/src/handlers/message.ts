import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionV2 } from "@novaclaw/core/session"
import { NamedError } from "@novaclaw/core/util/error"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { InvalidCursorError, InvalidRequestError, SessionNotFoundError, UnknownError } from "@novaclaw/protocol/errors"
import * as nodeFs from "node:fs/promises"
import * as nodePath from "node:path"
import { SessionMarkdown } from "../session-markdown"

const DefaultMessagesLimit = 50

const Cursor = Schema.Struct({
  id: SessionMessage.ID,
  order: Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")]),
  direction: Schema.Union([Schema.Literal("previous"), Schema.Literal("next")]),
})

const decodeCursor = Schema.decodeUnknownSync(Cursor)

const cursor = {
  encode(message: SessionMessage.Message, order: "asc" | "desc", direction: "previous" | "next") {
    return Buffer.from(JSON.stringify({ id: message.id, order, direction })).toString("base64url")
  },
  decode(input: string) {
    return decodeCursor(JSON.parse(Buffer.from(input, "base64url").toString("utf8")))
  },
}

export const MessageHandler = HttpApiBuilder.group(Api, "server.message", (handlers) =>
  Effect.gen(function* () {
    const session = yield* SessionV2.Service

    // Export the whole session as Markdown. Reads with `order: "asc"` and pages through the cursor so a
    // long session is complete and chronological — the API's default is NEWEST-first, which would emit a
    // reversed transcript. A session mid-turn is exported as-is and flagged; we never pause it to export.
    const collectAll = Effect.fn(function* (sessionID: string) {
      const all: SessionMessage.Message[] = []
      let cursorRef: { id: SessionMessage.ID; direction: "next" } | undefined
      // Bounded so a pathological session cannot spin forever; 200 * 500 = 100k messages.
      for (let page = 0; page < 500; page += 1) {
        const batch = yield* session.messages({
          sessionID: sessionID as never,
          limit: 200,
          ...(cursorRef ? { cursor: cursorRef } : { order: "asc" as const }),
        })
        all.push(...batch)
        if (batch.length < 200) break
        const last = batch[batch.length - 1]
        if (!last) break
        cursorRef = { id: last.id, direction: "next" }
      }
      return all
    })

    return handlers.handle(
      "session.exportMarkdown",
      Effect.fn(function* (ctx) {
        const info = yield* session.get(ctx.params.sessionID).pipe(
          Effect.catchTag("Session.NotFoundError", (error) =>
            Effect.fail(
              new SessionNotFoundError({ sessionID: error.sessionID, message: `Session not found: ${error.sessionID}` }),
            ),
          ),
        )
        const messages = yield* collectAll(ctx.params.sessionID).pipe(
          // Reading messages can fail on a decode; surface it as UnknownError rather than widening the
          // endpoint's declared error channel (Effect 4 has catchCause, not catchAll).
          Effect.catchCause((cause) => Effect.fail(new UnknownError({ message: String(cause) }))),
        )
        const rendered = SessionMarkdown.render(messages, {
          sessionID: ctx.params.sessionID,
          ...(info.title ? { title: info.title } : {}),
          ...(info.location?.directory ? { directory: info.location.directory } : {}),
          exportedAt: Date.now(),
        })
        // A caller-supplied name is reduced to its BASENAME before use: the picker offers a text field, and
        // "../../etc/passwd" typed into it must land in the chosen folder as a file, not escape it.
        const suggested = SessionMarkdown.filename({
          sessionID: ctx.params.sessionID,
          ...(info.title ? { title: info.title } : {}),
        })
        const requested = ctx.payload.filename?.trim()
        const chosen = requested ? nodePath.basename(requested) || suggested : suggested
        const target = nodePath.join(ctx.payload.directory, chosen.endsWith(".md") ? chosen : `${chosen}.md`)
        yield* Effect.tryPromise({
          try: async () => {
            await nodeFs.mkdir(ctx.payload.directory, { recursive: true })
            await nodeFs.writeFile(target, rendered.markdown, "utf8")
          },
          catch: (error) =>
            new InvalidRequestError({
              message: `Could not write the export to ${ctx.payload.directory}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }),
        })
        return { path: target, messageCount: rendered.messageCount, running: rendered.running }
      }),
    ).handle(
      "session.messages",
      Effect.fn(function* (ctx) {
        if (ctx.query.cursor && ctx.query.order !== undefined)
          return yield* new InvalidCursorError({ message: "Cursor cannot be combined with order" })
        const decoded = yield* Effect.try({
          try: () => (ctx.query.cursor ? cursor.decode(ctx.query.cursor) : undefined),
          catch: () => new InvalidCursorError({ message: "Invalid cursor" }),
        })
        const order = decoded?.order ?? ctx.query.order ?? "desc"
        const messages = yield* session
          .messages({
            sessionID: ctx.params.sessionID,
            limit: ctx.query.limit ?? DefaultMessagesLimit,
            order,
            cursor: decoded ? { id: decoded.id, direction: decoded.direction } : undefined,
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
          )
        const first = messages[0]
        const last = messages.at(-1)
        return {
          data: messages,
          cursor: {
            previous: first ? cursor.encode(first, order, "previous") : undefined,
            next: last ? cursor.encode(last, order, "next") : undefined,
          },
        }
      }),
    )
  }),
)
