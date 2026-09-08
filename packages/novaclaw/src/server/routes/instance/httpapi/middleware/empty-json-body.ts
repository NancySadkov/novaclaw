import { Effect } from "effect"
import { HttpRouter, HttpServerRequest } from "effect/unstable/http"

// Generated clients drop an all-default JSON body entirely (buildClientParams → stripEmptySlots
// serializes `{}` to NO body), so every all-optional payload endpoint 400s with "Expected object,
// got undefined" on a zero-field call — the trap noted on session.fork, hit live by session.create.
// Treat an empty body on a JSON mutation request as the empty object at the transport layer, so
// all-optional payload structs accept zero-field calls without per-endpoint NullOr workarounds.
const JSON_CONTENT_TYPE = /^\s*application\/(?:[^;\s]+\+)?json\s*(?:;|$)/i
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"])

export const emptyJsonBodyLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (
      !BODY_METHODS.has(request.method) ||
      request.headers["content-length"] !== "0" ||
      !JSON_CONTENT_TYPE.test(request.headers["content-type"] ?? "")
    )
      return yield* effect

    // Content-length 0 guarantees the body is empty — serve "{}" without touching the source.
    const patched = new Proxy(request, {
      get(target, prop) {
        if (prop === "text") return Effect.succeed("{}")
        const value = Reflect.get(target, prop, target)
        return typeof value === "function" ? value.bind(target) : value
      },
    })
    return yield* Effect.provideService(effect, HttpServerRequest.HttpServerRequest, patched)
  }),
).layer
