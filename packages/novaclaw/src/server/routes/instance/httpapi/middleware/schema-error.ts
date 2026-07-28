import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"

// Effect's Issue formatter recursively dumps the rejected `actual` value with
// no truncation, so a 5KB invalid array produces a ~360KB string. Cap to keep
// 4xx responses small and avoid mirroring entire request payloads (which may
// contain secrets) into the response body and log file.
const REASON_LIMIT = 1024
function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `… (${reason.length - REASON_LIMIT} more chars)`
}

// Default Respondable returns an empty 400 body. Match the NamedError shape
// used by other 4xx/5xx so the SDK's `wrapClientError` extracts `.data.message`.
//
// ⚠️ The tag id must NOT be `@novaclaw/HttpApiSchemaError` — that belongs to
// `@novaclaw/protocol`'s middleware, which is the ONE contract (todo.md ruling 11).
// This is the legacy instance surface's own copy, and it carries DIFFERENT behaviour
// (the `/api/` path branch below). Both classes were registered under the identical
// string until 2026-07-28, and `httpapi/server.ts` imports both: an Effect `Context`
// is keyed by this string, so provisioning both into one context silently kept
// whichever came last — with no type error, because the two classes are structurally
// identical. Named for its siblings in this directory
// (`@novaclaw/ExperimentalHttpApi*`), which is also what marks it as the copy that
// dies when the legacy paths are retired. Uniqueness is enforced by
// `packages/protocol/test/context-key-uniqueness.test.ts`.
export class ExperimentalSchemaErrorMiddleware extends HttpApiMiddleware.Service<ExperimentalSchemaErrorMiddleware>()(
  "@novaclaw/ExperimentalHttpApiSchemaError",
  {
    error: InvalidRequestError,
  },
) {}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(
  ExperimentalSchemaErrorMiddleware,
  (error, context) => {
    const reason = truncateReason(error.cause.message)
    const response = context.endpoint.path.startsWith("/api/")
      ? Effect.fail(
          new InvalidRequestError({
            message: reason,
            kind: error.kind,
          }),
        )
      : Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { name: "BadRequest", data: { message: reason, kind: error.kind } },
            { status: 400 },
          ),
        )
    return Effect.logWarning("schema rejection", { kind: error.kind, reason }).pipe(Effect.andThen(response))
  },
)
