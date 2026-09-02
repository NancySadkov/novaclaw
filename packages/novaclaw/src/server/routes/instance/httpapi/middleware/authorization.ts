import { ServerAuth } from "@/server/auth"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"
import { isPublicUIPath } from "@/server/shared/public-ui"
import { ServerAuth as V2ServerAuth } from "@novaclaw/server/auth"
import { authorizationLayer as unconfiguredServerAuthorizationLayer } from "@novaclaw/server/middleware/authorization"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
export { Authorization as ServerAuthorization } from "@novaclaw/server/middleware/authorization"

export const AUTH_TOKEN_QUERY = "auth_token"
const UNAUTHORIZED = 401
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

/**
 * The launcher credential is a bootstrap default, not a second data-plane password. These two
 * read-only probes are the only requests the desktop parent must still make after a stored token
 * takes authority: liveness for supervision and the updater's airgap decision. Everything carrying
 * user data is authorized solely against the effective (stored-first) credential.
 */
const LAUNCH_DEFAULT_PROBE_PATHS = new Set(["/global/health", "/shell/offline"])

export function acceptsLaunchDefaultProbe(method: string, pathname: string) {
  return method === "GET" && LAUNCH_DEFAULT_PROBE_PATHS.has(pathname)
}

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

/**
 * 🔴 **A URL is not a credential channel, and this used to read `?auth_token=` on EVERY route.**
 *
 * A secret in a query string is indistinguishable from data to everything downstream of the check
 * that consumed it: it is copied into proxy targets, written to access logs, sent as a `Referer`
 * and kept in browser history. The sharpest consequence in this tree is the first of those —
 * `workspaceProxyURL` (`server/shared/workspace-routing.ts`) copies `requestURL.search` wholesale
 * into the target, so an ordinary request that merely PASSES THROUGH this instance carried this
 * instance's password to a machine that is not ours. That is the data plane egressing, and the far
 * end cannot un-see it.
 *
 * ⚠️ The query form cannot simply be deleted, because one caller structurally has no header to
 * set: the desktop hands the web UI off by NAVIGATING a browser to `/?auth_token=…`, and a
 * top-level navigation carries no `Authorization`. `packages/app/src/entry.tsx` strips the
 * parameter from the address bar on first paint, and every request after it uses the header.
 *
 * ⚠️ So the query form is confined to the surface that has that excuse. Two readers, deliberately
 * asymmetric:
 *
 * - `authorizationRouterMiddleware` — the UI document, `/doc` and the maintenance route. A browser
 *   navigation lands here and cannot set a header. Nothing on this surface declares
 *   `WorkspaceRoutingMiddleware`, so nothing it authorizes is ever proxied anywhere.
 * - `Authorization` (the typed HttpApi surface) — reached only by clients that CAN set a header
 *   (the SDK and the app both do), and the surface `workspaceProxyURL` forwards. Header only.
 *
 * ⚠️ This is a narrowing of the CHANNEL, not an identity check. HTTP here still cannot say who is
 * asking — `handlers/registry.ts` records why, and this middleware is one of the reasons it cannot.
 * "Which channel may carry a secret" is answerable without knowing the caller; "is this caller
 * allowed to use it" is not, so this fix does not pretend to answer the second.
 *
 * ⚠️ On the navigation surface the query still WINS over a header, and that ordering is load
 * bearing: once a browser has been prompted for Basic auth it replays the cached header on every
 * later navigation, so a header-first rule would let a stale prompt answer beat the fresh token the
 * desktop just minted.
 */
function credentialFromHeader(request: HttpServerRequest.HttpServerRequest) {
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

function credentialFromNavigation(url: URL, request: HttpServerRequest.HttpServerRequest) {
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  return credentialFromHeader(request)
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
    const settings = yield* SettingsConfigStore.Service

    // Resolve per request (stored server.password → launcher default) so token edits apply live.
    return (effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig, yield* settings.serverPassword())
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        if (isPublicUIPath(request.method, url.pathname)) return yield* effect
        const credential = yield* credentialFromNavigation(url, request)
        if (acceptsLaunchDefaultProbe(request.method, url.pathname) && ServerAuth.authorized(credential, envConfig))
          return yield* effect
        return yield* validateRawCredential(effect, credential, config)
      })
  }),
)

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const envConfig = yield* ServerAuth.Config
    const settings = yield* SettingsConfigStore.Service
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig, yield* settings.serverPassword())
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        const url = new URL(request.url, "http://localhost")
        const credential = yield* credentialFromHeader(request)
        if (acceptsLaunchDefaultProbe(request.method, url.pathname) && ServerAuth.authorized(credential, envConfig))
          return yield* effect
        return yield* validateCredential(effect, credential, config)
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
