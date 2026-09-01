import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { PermissionSaved } from "@novaclaw/core/permission/saved"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { PermissionApi, handlerLayer } from "../handler-api"
import { SessionNotFoundError } from "@novaclaw/protocol/errors"

export const PermissionHandler = handlerLayer(
  HttpApiBuilder.group(PermissionApi, "server.permission", (handlers) =>
    Effect.gen(function* () {
      return handlers
        .handle(
          "session.permission.create",
          Effect.fn(function* (ctx) {
            const permission = yield* PermissionV2.Service
            return {
              data: yield* permission
                .ask({
                  id: ctx.payload.id,
                  sessionID: ctx.params.sessionID,
                  action: ctx.payload.action,
                  resources: ctx.payload.resources,
                  save: ctx.payload.save,
                  metadata: ctx.payload.metadata,
                  source: ctx.payload.source,
                  agent: ctx.payload.agent,
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
                ),
            }
          }),
        )
        .handle(
          "permission.saved.list",
          Effect.fn(function* (ctx) {
            const location = yield* Location.Service
            return {
              data: yield* (yield* PermissionSaved.Service).list({
                origin: ctx.query.origin ?? location.origin,
              }),
            }
          }),
        )
        .handle(
          "permission.saved.remove",
          Effect.fn(function* (ctx) {
            yield* (yield* PermissionSaved.Service).remove(ctx.params.id)
            return HttpApiSchema.NoContent.make()
          }),
        )
    }),
  ),
)
