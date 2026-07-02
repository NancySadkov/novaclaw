import { PermissionV1 } from "@novaclaw/core/v1/permission"
import { PermissionV2 } from "@novaclaw/core/permission"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { Permission } from "@/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service
    const locations = yield* LocationServiceMap.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    // 1K: a V2-native session's ask is pending in the per-location PermissionV2 instance, not the
    // V1 service — but the (unchanged) clients reply through THIS route for both. On a V1 miss,
    // retry against the V2 service for the routed location before reporting not-found.
    const replyV2 = Effect.fn("PermissionHttpApi.replyV2")(function* (input: {
      requestID: string
      reply: PermissionV1.Reply
      message?: string
    }) {
      const ctx = yield* InstanceRef
      if (!ctx) return false
      const workspaceID = yield* WorkspaceRef
      const layer = locations.get(
        Location.Ref.make({ directory: AbsolutePath.make(ctx.directory), workspaceID }),
      )
      return yield* Effect.gen(function* () {
        const v2 = yield* PermissionV2.Service
        yield* v2.reply({
          requestID: PermissionV2.ID.make(input.requestID),
          reply: input.reply,
          message: input.message,
        })
        return true
      }).pipe(
        Effect.catchTag("PermissionV2.NotFoundError", () => Effect.succeed(false)),
        Effect.provide(layer),
        Effect.orDie,
      )
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionV1.ID }
      payload: PermissionV1.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.gen(function* () {
              const settled = yield* replyV2({
                requestID: ctx.params.requestID,
                reply: ctx.payload.reply,
                message: ctx.payload.message,
              })
              if (settled) return
              return yield* Effect.fail(
                new PermissionNotFoundError({
                  requestID: String(error.requestID),
                  message: `Permission request not found: ${error.requestID}`,
                }),
              )
            }),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
