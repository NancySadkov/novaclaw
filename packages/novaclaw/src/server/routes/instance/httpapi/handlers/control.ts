import { Auth } from "@/auth"

import { Log } from "@novaclaw/schema/log"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { RootHttpApi } from "../api"
import { ClientLog } from "./client-log"
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

    /**
     * `POST /log` — a CLIENT process's own faults reaching the instance log.
     *
     * The refusals, their measurements and the reason each one is shaped the way it is live in
     * `./client-log.ts`; this function is the wiring. Two properties are decided here and nowhere
     * else, so they are stated here:
     *
     *  · **The line is ours, not the caller's.** Level comes from the declared key, `message=` from
     *    the declaration, and every caller field is namespaced under `client.extra.` — so no post
     *    can add, overwrite or forge one of the line's own columns.
     *  · **A refusal is `false`, never an exception and never a silent `true`.** The success schema
     *    means *written*; ruling 2 forbids answering otherwise. Logging must not be able to take the
     *    instance down, so nothing here throws and nothing here rejects a crash report for size.
     */
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
      // ⚠️ The bucket is spent BEFORE anything is formatted, so a refused post costs no work at all
      // — a rate limit that still does the expensive part is not a bound on amplification.
      const suppressed = ClientLog.limiter.admit()
      if (suppressed === undefined) return false
      const fields = ClientLog.extra(ctx.payload.extra)
      yield* Log.event(key, {
        "client.service": ClientLog.service(ctx.payload.service),
        "client.message": ClientLog.truncate(ctx.payload.message, ClientLog.MAX_MESSAGE_CHARS),
      }).pipe(
        Effect.annotateLogs({
          ...fields.annotations,
          // Reported, not swallowed. A drop nobody can see is the "counter that can lie about the
          // thing it counts" shape — and both numbers are OURS, under a name no caller can reach.
          ...(fields.dropped === 0 ? {} : { [ClientLog.DROPPED_ATTRIBUTE]: String(fields.dropped) }),
          ...(suppressed === 0 ? {} : { [`${ClientLog.DROPPED_ATTRIBUTE}.rate`]: String(suppressed) }),
        }),
      )
      return true
    })

    return handlers.handle("authSet", authSet).handle("authRemove", authRemove).handle("log", log)
  }),
)
