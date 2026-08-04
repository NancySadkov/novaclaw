import { Session } from "@novaclaw/schema/session"
import { SessionMessage } from "@novaclaw/schema/session-message"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidCursorError, InvalidRequestError, SessionNotFoundError, UnknownError } from "../errors"

export const SessionMessagesQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.NumberFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(200)),
  ).annotate({
    description: "Maximum number of messages to return. When omitted, the endpoint returns its default page size.",
  }),
  order: Schema.optional(Schema.Union([Schema.Literal("asc"), Schema.Literal("desc")])).annotate({
    description: "Message order for the first page. Use desc for newest first or asc for oldest first.",
  }),
  cursor: Schema.optional(
    Schema.String.annotate({
      description:
        "Opaque pagination cursor returned as cursor.previous or cursor.next in the previous response. Do not combine with order.",
    }),
  ),
}).annotate({ identifier: "SessionMessagesQuery" })

export const SessionExportResponse = Schema.Struct({
  path: Schema.String,
  messageCount: Schema.Number,
  /** True when the session was still producing output as it was exported (the file says so too). */
  running: Schema.Boolean,
}).annotate({ identifier: "SessionExportResponse" })

export const MessageGroup = HttpApiGroup.make("server.message")
  .add(
    // Named `exportMarkdown`, not `export`: the generated client derives its method name from the LAST
    // dot-segment, and `export` is a reserved word.
    HttpApiEndpoint.post("session.exportMarkdown", "/api/session/:sessionID/export-markdown", {
      params: { sessionID: Session.ID },
      payload: Schema.Struct({
        directory: Schema.String.annotate({ description: "Absolute folder to write the .md into." }),
        filename: Schema.String.pipe(Schema.optional).annotate({
          description: "File name to write. Omitted = derived from the session title. Basename only.",
        }),
      }),
      success: SessionExportResponse,
      error: [SessionNotFoundError, InvalidRequestError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.exportMarkdown",
        summary: "Export a session as Markdown",
        description:
          "Render the whole session to a Markdown file in the given folder. A session that is still running exports what exists so far and is marked as captured mid-turn.",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.get("session.messages", "/api/session/:sessionID/message", {
      params: { sessionID: Session.ID },
      query: SessionMessagesQuery,
      success: Schema.Struct({
        data: Schema.Array(SessionMessage.Message),
        cursor: Schema.Struct({
          previous: Schema.String.pipe(Schema.optional),
          next: Schema.String.pipe(Schema.optional),
        }),
      }).annotate({ identifier: "SessionMessagesResponse" }),
      error: [InvalidCursorError, SessionNotFoundError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.messages",
        summary: "Get session messages",
        description:
          "Retrieve projected messages for a session. Items keep the requested order across pages; use cursor.next or cursor.previous to move through the ordered timeline.",
      }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "messages",
      description: "Experimental message routes.",
    }),
  )
