import { PermissionRuleset } from "@novaclaw/schema/permission-ruleset"
import { Permission } from "@/permission"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { PermissionNotFoundError } from "../errors"

// S7: this route serves the V1 engine's asks ONLY. A V2-native session's asks live in the
// per-location PermissionV2 instance and ride the native surface (`GET /api/permission/request`
// + `POST /api/session/{sid}/permission/{rid}/reply`) — the V2 merge/fallback this handler used
// to carry retired with the V1 render vocab. The whole route goes with the V1 engine (F1f).
export const permissionHandlers = HttpApiBuilder.group(InstanceHttpApi, "permission", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* Permission.Service

    const list = Effect.fn("PermissionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("PermissionHttpApi.reply")(function* (ctx: {
      params: { requestID: PermissionRuleset.ID }
      payload: PermissionRuleset.ReplyBody
    }) {
      yield* svc
        .reply({
          requestID: ctx.params.requestID,
          reply: ctx.payload.reply,
          message: ctx.payload.message,
        })
        .pipe(
          Effect.catchTag("Permission.NotFoundError", (error) =>
            Effect.fail(
              new PermissionNotFoundError({
                requestID: String(error.requestID),
                message: `Permission request not found: ${error.requestID}`,
              }),
            ),
          ),
        )
      return true
    })

    return handlers.handle("list", list).handle("reply", reply)
  }),
)
