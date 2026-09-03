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
  messageCount: Schema.Finite,
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
        /**
         * 🔴 **RELATIVE, and it used to be "Absolute folder to write the .md into"** (Codex review
         * NC-SEC-017). An unconstrained absolute path made this endpoint a general *"create
         * directories and replace one chosen .md"* primitive over every path the NovaClaw account can
         * write: a sibling checkout, Documents, a drive root. The standing filesystem law permits
         * NovaClaw's own writes in exactly three places — instance home, OS temp, and the session's
         * working folder — and names drive roots, system locations and Documents as read-only, with
         * no fourth location. On a headless or remote runtime the path is not even on the caller's
         * machine.
         */
        // ⚠️ `.annotate()` BEFORE `.pipe(Schema.optional)`, not after. Annotating the optional
        // WRAPPER drops the description from the OpenAPI projection — measured here: `filename`
        // carried its text this way and the generated spec showed a bare `{"type":"string"}`. A
        // contract nobody can read is the same defect as a contract that lies, one step earlier.
        directory: Schema.String.annotate({
          description:
            "Folder to write the .md into, relative to the session's own project folder. Omitted = that folder itself." +
            " An absolute path, or one that resolves outside the project, is refused.",
        }).pipe(Schema.optional),
        filename: Schema.String.annotate({
          description: "File name to write. Omitted = derived from the session title. Basename only.",
        }).pipe(Schema.optional),
      }),
      success: SessionExportResponse,
      error: [SessionNotFoundError, InvalidRequestError, UnknownError],
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.session.exportMarkdown",
        summary: "Export a session as Markdown",
        description:
          "Render the whole session to a Markdown file inside the session's own project folder. The destination is" +
          " relative to that folder and never replaces an existing file — a name collision is written alongside it, and" +
          " the response says where the bytes actually landed. A session that is still running exports what exists so" +
          " far and is marked as captured mid-turn.",
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
