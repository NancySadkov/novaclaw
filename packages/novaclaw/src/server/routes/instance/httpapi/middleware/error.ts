import { NamedError } from "@novaclaw/core/util/error"
import { ConfigError } from "@novaclaw/core/config/error"
import { Cause, Effect } from "effect"
import { HttpRouter, HttpServerError, HttpServerRespondable, HttpServerResponse } from "effect/unstable/http"

// Keep typed HttpApi failures on their declared error path; this boundary only replaces defect-only empty 500s.
export const errorLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  effect.pipe(
    Effect.catchCause((cause) => {
      const defect = cause.reasons.filter(Cause.isDieReason).find((reason) => {
        if (HttpServerResponse.isHttpServerResponse(reason.defect)) return false
        if (HttpServerError.isHttpServerError(reason.defect)) return false
        if (HttpServerRespondable.isRespondable(reason.defect)) return false
        return true
      })
      if (!defect) return Effect.failCause(cause)

      const error = defect.defect
      if (
        ConfigError.JsonError.isInstance(error) ||
        ConfigError.InvalidError.isInstance(error) ||
        ConfigError.FrontmatterError.isInstance(error) ||
        ConfigError.DirectoryTypoError.isInstance(error)
      ) {
        return Effect.succeed(HttpServerResponse.jsonUnsafe(error.toObject(), { status: 400 }))
      }

      const ref = `err_${crypto.randomUUID().slice(0, 8)}`

      // `console.error` as well as the Effect log: this boundary is the last thing that sees a defect,
      // and in the packaged desktop app the Effect log did NOT reach the sidecar's captured output —
      // so a 500 whose message said "check server logs" left literally nothing behind in any log,
      // anywhere. The sidecar's stdout/stderr IS piped to the app's server.log, so writing there
      // directly guarantees the reference can always be traced back to a cause.
      console.error(`[novaclaw] internal error ${ref}:`, error, Cause.pretty(cause))

      return Effect.logError("failed", { ref, error, cause: Cause.pretty(cause) }).pipe(
        Effect.as(
          HttpServerResponse.jsonUnsafe(
            new NamedError.Unknown({
              message: NamedError.internalMessage(ref),
              ref,
            }).toObject(),
            { status: 500 },
          ),
        ),
      )
    }),
  ),
).layer
