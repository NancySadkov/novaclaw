import { Pty } from "@novaclaw/core/pty"
import { PtyProtocol } from "@novaclaw/core/pty/protocol"
import { Ticket } from "@novaclaw/core/ticket"
import { Location } from "@novaclaw/core/location"
import { Shell } from "@novaclaw/core/shell"
import { Deferred, Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import * as Socket from "effect/unstable/socket/Socket"
import { PtyApi, handlerLayer } from "../handler-api"
import { CorsConfig, isAllowedRequestOrigin } from "../cors"
import { ForbiddenError, PtyNotFoundError } from "@novaclaw/protocol/errors"
import { TICKET_QUERY, TICKET_REQUEST_HEADER, TICKET_REQUEST_HEADER_VALUE } from "@novaclaw/schema/ticket"
import { response } from "../location"
import { makeByteBoundedOutbox } from "./pty-outbox"
import { WebSocketTracker } from "../websocket-tracker"

const ptyFrameBytes = (frame: string | Uint8Array | Socket.CloseEvent) =>
  frame instanceof Socket.CloseEvent
    ? 0
    : typeof frame === "string"
      ? Buffer.byteLength(frame, "utf8")
      : frame.byteLength

const ticketScope = Effect.gen(function* () {
  const location = yield* Location.Service
  return { directory: location.directory as string, workspaceID: location.workspaceID }
})

export const PtyHandler = handlerLayer(
  HttpApiBuilder.group(PtyApi, "server.pty", (handlers) =>
    Effect.gen(function* () {
      const tickets = yield* Ticket.Service
      const cors = yield* CorsConfig

      return handlers
        .handle(
          "pty.shells",
          Effect.fn(function* () {
            return yield* Effect.promise(() => Shell.list())
          }),
        )
        .handle(
          "pty.list",
          Effect.fn(function* () {
            return yield* response((yield* Pty.Service).list())
          }),
        )
        .handle(
          "pty.create",
          Effect.fn(function* (ctx) {
            const pty = yield* Pty.Service
            const location = yield* Location.Service
            const cwd = ctx.payload.cwd || location.directory
            return yield* response(
              pty.create({
                ...ctx.payload,
                args: ctx.payload.args ? [...ctx.payload.args] : undefined,
                cwd,
                // The host env OVERLAY is gone with the V1 plugin arm: `shell.env` was its only
                // producer, so the `PtyEnvironment` service (and its empty default) could contribute
                // nothing but `{}` for every install. Both halves went (todo.md, "a HALF-dark feature
                // is zombie code"). Composing a spawn environment is still wanted — as ONE gate for
                // bash/pty/every spawn (`core/host-exec.ts`, ruling 6), never a per-route hook.
                env: { ...ctx.payload.env },
              }),
            )
          }),
        )
        .handle(
          "pty.get",
          Effect.fn(function* (ctx) {
            const pty = yield* Pty.Service
            return yield* response(
              pty.get(ctx.params.ptyID).pipe(
                Effect.catchTag(
                  "Pty.NotFoundError",
                  () =>
                    new PtyNotFoundError({
                      ptyID: ctx.params.ptyID,
                      message: `PTY session not found: ${ctx.params.ptyID}`,
                    }),
                ),
              ),
            )
          }),
        )
        .handle(
          "pty.activity",
          Effect.fn(function* (ctx) {
            const pty = yield* Pty.Service
            return yield* response(
              pty.activity(ctx.params.ptyID).pipe(
                Effect.catchTag(
                  "Pty.NotFoundError",
                  () =>
                    new PtyNotFoundError({
                      ptyID: ctx.params.ptyID,
                      message: `PTY session not found: ${ctx.params.ptyID}`,
                    }),
                ),
              ),
            )
          }),
        )
        .handle(
          "pty.update",
          Effect.fn(function* (ctx) {
            const pty = yield* Pty.Service
            return yield* response(
              pty
                .update(ctx.params.ptyID, {
                  ...ctx.payload,
                  size: ctx.payload.size ? { ...ctx.payload.size } : undefined,
                })
                .pipe(
                  Effect.catchTag(
                    "Pty.NotFoundError",
                    () =>
                      new PtyNotFoundError({
                        ptyID: ctx.params.ptyID,
                        message: `PTY session not found: ${ctx.params.ptyID}`,
                      }),
                  ),
                ),
            )
          }),
        )
        .handle(
          "pty.removeAll",
          Effect.fn(function* () {
            const pty = yield* Pty.Service
            return yield* response(pty.removeAll())
          }),
        )
        .handle(
          "pty.remove",
          Effect.fn(function* (ctx) {
            const pty = yield* Pty.Service
            yield* pty.remove(ctx.params.ptyID).pipe(
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
            )
            return HttpApiSchema.NoContent.make()
          }),
        )
        .handle(
          "pty.connectToken",
          Effect.fn(function* (ctx) {
            const request = yield* HttpServerRequest.HttpServerRequest
            // The custom header forces a CORS preflight, so cross-origin browser pages cannot
            // mint tickets without passing the server's origin policy.
            if (
              request.headers[TICKET_REQUEST_HEADER] !== TICKET_REQUEST_HEADER_VALUE ||
              !isAllowedRequestOrigin(request.headers.origin, request.headers.host, cors)
            )
              return yield* new ForbiddenError({ message: "Invalid PTY connect token request" })
            const pty = yield* Pty.Service
            yield* pty.get(ctx.params.ptyID).pipe(
              Effect.catchTag(
                "Pty.NotFoundError",
                () =>
                  new PtyNotFoundError({
                    ptyID: ctx.params.ptyID,
                    message: `PTY session not found: ${ctx.params.ptyID}`,
                  }),
              ),
            )
            return yield* response(
              tickets.issue({ kind: "pty.connect", ptyID: ctx.params.ptyID, ...(yield* ticketScope) }),
            )
          }),
        )
        .handleRaw(
          "pty.connect",
          Effect.fn("PtyHandler.connect")(function* (ctx) {
            const pty = yield* Pty.Service
            const exists = yield* pty.get(ctx.params.ptyID).pipe(
              Effect.as(true),
              Effect.catchTag("Pty.NotFoundError", () => Effect.succeed(false)),
            )
            if (!exists) return HttpServerResponse.empty({ status: 404 })

            const url = new URL(ctx.request.url, "http://localhost")
            const ticket = url.searchParams.get(TICKET_QUERY)
            if (ticket) {
              const valid = isAllowedRequestOrigin(ctx.request.headers.origin, ctx.request.headers.host, cors)
                ? yield* tickets.consume(
                    { kind: "pty.connect", ptyID: ctx.params.ptyID, ...(yield* ticketScope) },
                    ticket,
                  )
                : false
              if (!valid) return HttpServerResponse.empty({ status: 403 })
            }
            const parsedCursor = url.searchParams.get("cursor")
            const cursorNumber = parsedCursor === null ? undefined : Number(parsedCursor)
            const cursor =
              cursorNumber !== undefined && Number.isSafeInteger(cursorNumber) && cursorNumber >= -1
                ? cursorNumber
                : undefined

            const socket = yield* Effect.orDie(ctx.request.upgrade)
            const write = yield* socket.writer
            const closeAccepted = (event: Socket.CloseEvent) =>
              socket
                .runRaw(() => Effect.void, { onOpen: write(event).pipe(Effect.catch(() => Effect.void)) })
                .pipe(
                  Effect.timeout("1 second"),
                  Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
                  Effect.catch(() => Effect.void),
                )

            // Outbound frames flow through one byte-bounded queue drained by a single writer so
            // replay, live output, and the close frame keep their order. A socket that cannot keep
            // up is closed and can resume from its last cursor; it must not become a second,
            // lossless PTY history in the server heap.
            const detached = yield* Deferred.make<void>()
            const registered = yield* WebSocketTracker.register(
              write(WebSocketTracker.SERVER_CLOSING_EVENT()).pipe(
                Effect.andThen(Deferred.await(detached)),
                Effect.catch(() => Effect.void),
              ),
            )
            if (!registered) {
              yield* closeAccepted(WebSocketTracker.SERVER_CLOSING_EVENT())
              return HttpServerResponse.empty()
            }
            const outbox = yield* makeByteBoundedOutbox<string | Uint8Array | Socket.CloseEvent>(ptyFrameBytes)
            const enqueueData = (chunk: string) => {
              for (const frame of PtyProtocol.chunks(chunk)) {
                if (!outbox.offerUnsafe(frame)) break
              }
            }
            const attachment = yield* pty
              .attach(ctx.params.ptyID, {
                cursor,
                onData: enqueueData,
                onEnd: () => outbox.offerUnsafe(new Socket.CloseEvent(1000)),
              })
              .pipe(
                Effect.catchTags({
                  "Pty.NotFoundError": () =>
                    closeAccepted(new Socket.CloseEvent(4404, "session not found")).pipe(Effect.as(undefined)),
                  "Pty.ExitedError": () =>
                    closeAccepted(new Socket.CloseEvent(4404, "session exited")).pipe(Effect.as(undefined)),
                }),
              )
            if (!attachment) return HttpServerResponse.empty()

            for (const chunk of PtyProtocol.chunks(attachment.replay)) {
              if (!outbox.offerUnsafe(chunk)) break
            }
            outbox.offerUnsafe(PtyProtocol.metaFrame(attachment.cursor))
            attachment.activate()

            const drain = Effect.gen(function* () {
              while (true) {
                const item = yield* outbox.take
                const written = yield* write(item).pipe(
                  Effect.as(true),
                  Effect.timeout("5 seconds"),
                  Effect.catch(() => Effect.succeed(false)),
                )
                if (item instanceof Socket.CloseEvent) return
                if (!written || outbox.overflowed()) {
                  yield* write(new Socket.CloseEvent(1013, "PTY output consumer too slow; reconnect to resume.")).pipe(
                    Effect.timeout("1 second"),
                    Effect.catch(() => Effect.void),
                  )
                  return
                }
              }
            })

            yield* Effect.race(
              drain,
              socket.runRaw((message) => {
                const decoded = PtyProtocol.decodeInput(message)
                if (decoded !== undefined) attachment.write(decoded)
              }),
            ).pipe(
              Effect.catchReason("SocketError", "SocketCloseError", () => Effect.void),
              Effect.ensuring(Effect.sync(() => attachment.detach())),
              Effect.ensuring(Deferred.succeed(detached, undefined)),
              Effect.orDie,
            )
            return HttpServerResponse.empty()
          }),
        )
    }),
  ),
)
