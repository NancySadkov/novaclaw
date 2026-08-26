import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionV2 } from "@novaclaw/core/session"
import { NamedError } from "@novaclaw/core/util/error"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Effect, Schema } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { MessageApi, handlerLayer } from "../handler-api"
import { InvalidCursorError, InvalidRequestError, SessionNotFoundError, UnknownError } from "@novaclaw/protocol/errors"
import * as nodeFs from "node:fs/promises"
import * as nodePath from "node:path"
import { SessionMarkdown } from "../session-markdown"
import { Log } from "@novaclaw/schema/log"

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

export const MessageHandler = handlerLayer(
  HttpApiBuilder.group(MessageApi, "server.message", (handlers) =>
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

      return handlers
        .handle(
          "session.exportMarkdown",
          Effect.fn(function* (ctx) {
            const info = yield* session.get(ctx.params.sessionID).pipe(
              Effect.catchTag("Session.NotFoundError", (error) =>
                Effect.fail(
                  new SessionNotFoundError({
                    sessionID: error.sessionID,
                    message: `Session not found: ${error.sessionID}`,
                  }),
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

            /**
             * 🔴 **The destination is resolved inside the SESSION'S OWN project folder** (Codex
             * review NC-SEC-017). This handler used to take the payload's absolute `directory`
             * verbatim: it obtained the session, then `mkdir -p`'d and wrote to an unrelated path
             * with no comparison to the session location, instance home or temp. Basename
             * normalisation above stopped filename traversal and did nothing at all about the
             * directory that owns the write, so an authenticated client had a general "create
             * directories and replace one chosen `.md`" primitive over every path the NovaClaw
             * account can write — a sibling checkout, Documents, a drive root — on a machine that,
             * for a headless or remote runtime, is not even the caller's.
             *
             * ⚠️ The canonical check as well as the lexical one, for the reason
             * `FSUtil.containsCanonical` states: a symlink or junction inside the project makes an
             * escaping path look internal to a string comparison.
             */
            const root = info.location?.directory
            if (root === undefined)
              return yield* new InvalidRequestError({
                message: "This session has no project folder, so there is nowhere inside it to export to",
              })
            const into = ctx.payload.directory?.trim()
            if (into !== undefined && into !== "" && nodePath.isAbsolute(into))
              return yield* new InvalidRequestError({
                message: "The export folder is relative to this session's project folder, not an absolute path",
              })
            const folder = nodePath.resolve(root, into === undefined || into === "" ? "." : into)
            if (!FSUtil.contains(root, folder) || !FSUtil.containsCanonical(root, folder))
              return yield* new InvalidRequestError({
                message: "That export folder is outside this session's project folder",
              })

            const name = chosen.endsWith(".md") ? chosen : `${chosen}.md`
            const target = yield* Effect.tryPromise({
              try: async () => {
                await nodeFs.mkdir(folder, { recursive: true })
                /**
                 * 🔴 **`wx`, so an export never REPLACES.** The old call was a plain `writeFile`,
                 * which truncates by default: exporting over an existing `.md` destroyed it with no
                 * warning, no backup, no permission decision and no Trash entry. A collision now
                 * lands beside the file instead, and the response's `path` — which the caller
                 * already reads — says where the bytes actually went, so nothing is guessed and
                 * nothing is lost.
                 */
                const base = name.slice(0, -".md".length)
                for (let attempt = 0; ; attempt++) {
                  const candidate = nodePath.join(folder, attempt === 0 ? name : `${base} (${attempt + 1}).md`)
                  try {
                    await nodeFs.writeFile(candidate, rendered.markdown, { encoding: "utf8", flag: "wx" })
                    return candidate
                  } catch (error) {
                    // Give up rather than spin: 200 same-named exports in one folder is a caller
                    // problem, and a silent infinite loop would be a worse answer than a message.
                    if ((error as { code?: string })?.code !== "EEXIST" || attempt >= 200) throw error
                  }
                }
              },
              catch: (error) =>
                new InvalidRequestError({
                  message: `Could not write the export to ${folder}: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                }),
            })
            return { path: target, messageCount: rendered.messageCount, running: rendered.running }
          }),
        )
        .handle(
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
                  return Log.event("session.message.decode.failed", {
                    "session.ref": ref,
                    "session.id": error.sessionID,
                    "session.message": error.messageID,
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
  ),
)
