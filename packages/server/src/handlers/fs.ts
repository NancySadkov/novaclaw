import { FileSystem } from "@novaclaw/core/filesystem"
import { Location } from "@novaclaw/core/location"
import { Snapshot } from "@novaclaw/core/snapshot"
import { RelativePath } from "@novaclaw/core/schema"
import { Ticket } from "@novaclaw/core/ticket"
import { ForbiddenError, InvalidRequestError } from "@novaclaw/protocol/errors"
import { fileReadPath } from "@novaclaw/protocol/groups/fs"
import { TICKET_QUERY, TICKET_REQUEST_HEADER, TICKET_REQUEST_HEADER_VALUE } from "@novaclaw/schema/ticket"
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { FileSystemApi, handlerLayer } from "../handler-api"
import { response } from "../location"

/**
 * The location a ticket is scoped to, alongside the file itself.
 *
 * The same name is a different file in a different directory, so a ticket that named only the file
 * would let one workspace's download read another's.
 */
const ticketLocation = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID as string | undefined }
})

export const FileSystemHandler = handlerLayer(
  HttpApiBuilder.group(FileSystemApi, "server.fs", (handlers) =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const cors = yield* CorsConfig

      return handlers
        .handleRaw("fs.read", (ctx) =>
          Effect.gen(function* () {
            const url = new URL(ctx.request.url, "http://localhost")
            const path = fileReadPath(url)
            if (path === undefined) return HttpServerResponse.empty({ status: 404 })

            // 🔴 **A ticket in the URL is why the authorization middleware let this request through**
            // (`hasFileReadTicketURL`), so refusing an invalid one here is not defence in depth — it
            // IS the check. A handler that read the parameter and shrugged would turn `?ticket=x`
            // into an unauthenticated read of any file on the host.
            //
            // ⚠️ Consumed whenever the parameter is PRESENT, never only when the credential was
            // absent: the handler cannot see whether the middleware was satisfied by a header, and a
            // rule of "skip the check if they also sent Basic" is a rule that stops being true the
            // day something else calls this route.
            const ticket = url.searchParams.get(TICKET_QUERY)
            if (ticket !== null) {
              const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
                ? yield* tickets.consume({ kind: "fs.read", path, ...(yield* ticketLocation) }, ticket)
                : false
              if (!valid) return yield* new ForbiddenError({ message: "Invalid or expired file read ticket" })
            }

            const file = yield* (yield* FileSystem.Service).read({ path: RelativePath.make(path) })
            // ⚠️ **Bytes, not a string.** The download half of this feature exists because a large
            // artefact must never fit in a JS string — that is what rules out the `data:` URL the
            // chat's IMAGE path uses. Base64-ing the body here would reintroduce exactly that cost
            // one layer down, where nothing on the client could see it.
            return HttpServerResponse.uint8Array(file.content, { contentType: file.mime })
          }),
        )
        .handle(
          "fs.readToken",
          Effect.fn(function* (ctx) {
            const request = yield* HttpServerRequest.HttpServerRequest
            // The custom header forces a CORS preflight, so cross-origin browser pages cannot mint
            // tickets against a logged-in user's instance without passing its origin policy.
            if (
              request.headers[TICKET_REQUEST_HEADER] !== TICKET_REQUEST_HEADER_VALUE ||
              !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
            )
              return yield* new ForbiddenError({ message: "Invalid file read token request" })
            // ⚠️ No existence check, deliberately: a ticket for a file that is not there spends
            // itself on a 404, which is what an unticketed read of the same path already answers.
            // Probing here would only move the same answer earlier.
            return yield* response(tickets.issue({ kind: "fs.read", path: ctx.query.path, ...(yield* ticketLocation) }))
          }),
        )
        .handle("fs.snapshotRead", (ctx) =>
          response(
            Effect.gen(function* () {
              const result = yield* (yield* Snapshot.Service)
                .read({
                  snapshot: Snapshot.ID.make(ctx.query.snapshot),
                  path: RelativePath.make(ctx.query.path),
                })
                .pipe(Effect.mapError((error) => new InvalidRequestError({ message: error.message })))
              return {
                type: "binary" as const,
                content: Buffer.from(result.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: result.mime,
              }
            }),
          ),
        )
        .handle("fs.list", (ctx) =>
          response(
            Effect.gen(function* () {
              const fs = yield* FileSystem.Service
              return yield* fs.list(ctx.query)
            }),
          ),
        )
        .handle("fs.find", (ctx) =>
          response(
            Effect.gen(function* () {
              const fs = yield* FileSystem.Service
              return yield* fs.find(ctx.query)
            }),
          ),
        )
    }),
  ),
)
