import { Auth } from "@/auth"

import { Log } from "@novaclaw/schema/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { LogInput } from "../groups/control"
import { ProviderV2 } from "@novaclaw/core/provider"

export const controlHandlers = HttpApiBuilder.group(RootHttpApi, "control", (handlers) =>
  Effect.gen(function* () {
    const auth = yield* Auth.Service

    const authSet = Effect.fn("ControlHttpApi.authSet")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
      payload: Auth.Info
    }) {
      yield* auth.set(ctx.params.providerID, ctx.payload).pipe(Effect.orDie)
      return true
    })

    const authRemove = Effect.fn("ControlHttpApi.authRemove")(function* (ctx: {
      params: { providerID: ProviderV2.ID }
    }) {
      yield* auth.remove(ctx.params.providerID).pipe(Effect.orDie)
      return true
    })

    const log = Effect.fn("ControlHttpApi.log")(function* (ctx: { payload: typeof LogInput.Type }) {
      // 🔴 A KEYED event per level, not `Effect.log*`. This used to select `Effect.logDebug`/`logInfo`/…
      // into a variable and call it, which is a direct log by any honest reading — but the log-event
      // ledger matched CALL expressions, and a reference assigned to a variable is not one, so this
      // sat in the guard's blind spot while its doc claimed no direct call survived anywhere.
      //
      // ⚠️ Four keys rather than one with the level as an attribute: a registered event's level is
      // fixed at declaration, so collapsing them would land every client line at one severity. The
      // client's free-form text is DATA on a keyed event — which is what the keyed vocabulary is for,
      // rather than an argument against it.
      const key =
        ctx.payload.level === "debug"
          ? "client.log.debug"
          : ctx.payload.level === "info"
            ? "client.log.info"
            : ctx.payload.level === "warn"
              ? "client.log.warn"
              : "client.log.error"
      yield* Log.event(key, {
        "client.service": ctx.payload.service,
        "client.message": ctx.payload.message,
      }).pipe(Effect.annotateLogs(ctx.payload.extra ?? {}))
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
