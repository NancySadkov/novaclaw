import { Effect } from "effect"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"
import { Log } from "@novaclaw/schema/log"
export { SchemaErrorMiddleware } from "@novaclaw/protocol/middleware/schema-error"

const REASON_LIMIT = 1024

function truncateReason(reason: string) {
  if (reason.length <= REASON_LIMIT) return reason
  return reason.slice(0, REASON_LIMIT) + `... (${reason.length - REASON_LIMIT} more chars)`
}

export const schemaErrorLayer = HttpApiMiddleware.layerSchemaErrorTransform(SchemaErrorMiddleware, (error) => {
  const reason = truncateReason(error.cause.message)
  return Log.event("server.schema.rejection", { "server.kind": error.kind, "server.reason": reason }).pipe(
    Effect.andThen(Effect.fail(new InvalidRequestError({ message: reason, kind: error.kind }))),
  )
})
