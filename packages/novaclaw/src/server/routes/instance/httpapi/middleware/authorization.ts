import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { isPublicUIPath } from "@/server/shared/public-ui"
import { ServerAuth as V2ServerAuth } from "@novaclaw/server/auth"
import { authorizationLayer as unconfiguredServerAuthorizationLayer } from "@novaclaw/server/middleware/authorization"
export { Authorization as ServerAuthorization } from "@novaclaw/server/middleware/authorization"

const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

// Avoid HttpApiSecurity alternatives here: Effect security middleware wraps the
// full handler, so a downstream failure can make the next auth alternative run
// and remap an authorized NotFound into Unauthorized.
export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@novaclaw/ExperimentalHttpApiAuthorization",
  {
    error: HttpApiError.UnauthorizedNoContent,
  },
) {}

function emptyCredential() {
  return {
    username: "",
    password: Redacted.make(""),
  }
}

function validateCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  return Effect.gen(function* () {
    if (!ServerAuth.required(config)) return yield* effect
    if (!ServerAuth.authorized(credential, config)) {
      yield* HttpEffect.appendPreResponseHandler((_request, response) =>
        Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
      )
      return yield* new HttpApiError.Unauthorized({})
    }
    return yield* effect
  })
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return {
          username: header.slice(0, separator),
          password: Redacted.make(header.slice(separator + 1)),
        }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  return credentialFromURL(new URL(request.url, "http://localhost"), request)
}

function credentialFromURL(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function validateRawCredential<A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: ServerAuth.DecodedCredentials,
  config: ServerAuth.Info,
) {
  if (!ServerAuth.required(config)) return effect
  if (!ServerAuth.authorized(credential, config))
    return Effect.succeed(
      HttpServerResponse.empty({
        status: UNAUTHORIZED,
        headers: { "www-authenticate": WWW_AUTHENTICATE },
      }),
    )
  return effect
}

export const authorizationRouterMiddleware = HttpRouter.middleware()(
  Effect.gen(function* () {
    const envConfig = yield* ServerAuth.Config

    // P2P: resolve per request (env → settings store) so token edits apply live.
    return (effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig)
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        return yield* credentialFromURL(url, request).pipe(
          Effect.flatMap((credential) => validateRawCredential(effect, credential, config)),
        )
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const envConfig = yield* ServerAuth.Config
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig)
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* credentialFromRequest(request).pipe(
          Effect.flatMap((credential) => validateCredential(effect, credential, config)),
        )
      }),
    )
  }),
)

/**
 * `@novaclaw/server`'s authorization middleware, ALREADY PAIRED with `@novaclaw/server`'s own config.
 *
 * The pairing lives here rather than at the call site because a call site had to CHOOSE, and the only
 * thing telling it which of two identically-shaped `ServerAuth.Config` classes to feed was a comment.
 * Both classes were registered under `@novaclaw/ServerAuthConfig` until 2026-07-28 (v0.2.0 PREP,
 * Wave 1 / U3), so `httpapi/server.ts` fed this middleware the INSTANCE config and it type-checked and
 * ran — the wrong layer satisfying the requirement by key collision. The rename made that a type error;
 * providing the layer here deletes the choice altogether, which is the part a comment could not do.
 *
 * A test that needs to inject a config imports `authorizationLayer` from
 * `@novaclaw/server/middleware/authorization` directly and provides `ServerAuth.Config` itself.
 */
export const serverAuthorizationLayer = unconfiguredServerAuthorizationLayer.pipe(
  Layer.provide(V2ServerAuth.Config.defaultLayer),
)
