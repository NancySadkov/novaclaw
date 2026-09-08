import { Schema } from "effect"

/**
 * ⚠️ `InvalidRequestError` is a re-export of the canonical error.
 *
 * This file used to declare its own versions with the same `_tag`, the same fields and the same
 * `httpApiStatus`. Both sides feed ONE OpenAPI document and Effect keys components on the
 * identifier, so the spec carried a single component for each: whichever AST the emitter reached
 * first won, and half the endpoints would have `$ref`-ed a component that did not describe what they
 * return the moment one copy gained a field. Nothing surfaces that collision — the whole spec has
 * exactly one numbered-suffix name — so the divergence would have been invisible.
 *
 * The classes below are the ones `@novaclaw/protocol` does NOT declare. They live here until their
 * routes move.
 */
export { InvalidRequestError } from "@novaclaw/protocol/errors"

export class McpServerNotFoundError extends Schema.TaggedErrorClass<McpServerNotFoundError>()(
  "McpServerNotFoundError",
  {
    name: Schema.String,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {}

export class FilePreviewTooLargeError extends Schema.TaggedErrorClass<FilePreviewTooLargeError>()(
  "FilePreviewTooLargeError",
  {
    message: Schema.String,
    bytes: Schema.Number,
    limit: Schema.Number,
  },
  { httpApiStatus: 413 },
) {}

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}
