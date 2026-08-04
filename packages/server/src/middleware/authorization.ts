import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@novaclaw/protocol/errors"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
export { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { hasPtyConnectTicketURL } from "@novaclaw/protocol/groups/pty"
import { Effect, Encoding, Layer, Redacted } from "effect"
import { HttpEffect, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const AUTH_TOKEN_QUERY = "auth_token"
const WWW_AUTHENTICATE = 'Basic realm="Secure Area"'

function emptyCredential() {
  return { username: "", password: Redacted.make("") }
}

function decodeCredential(input: string) {
  return Effect.fromResult(Encoding.decodeBase64String(input)).pipe(
    Effect.match({
      onFailure: emptyCredential,
      onSuccess: (header) => {
        const separator = header.indexOf(":")
        if (separator === -1) return emptyCredential()
        return { username: header.slice(0, separator), password: Redacted.make(header.slice(separator + 1)) }
      },
    }),
  )
}

function credentialFromRequest(request: HttpServerRequest.HttpServerRequest) {
  const url = new URL(request.url, "http://localhost")
  const token = url.searchParams.get(AUTH_TOKEN_QUERY)
  if (token) return decodeCredential(token)
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const envConfig = yield* ServerAuth.Config
    // P2P: resolve the EFFECTIVE config per request (env override → the settings store's
    // server.password) so a token set in Settings → Instances starts gating without a restart.
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig)
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        // Browsers cannot set headers on WebSocket upgrades, so a ticketed PTY connect skips
        // credential checks here; the connect handler consumes and validates the ticket.
        if (hasPtyConnectTicketURL(new URL(request.url, "http://localhost"))) return yield* effect
        const credential = yield* credentialFromRequest(request)
        if (ServerAuth.authorized(credential, config)) return yield* effect
        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", WWW_AUTHENTICATE)),
        )
        return yield* new UnauthorizedError({ message: "Authentication required" })
      }),
    )
  }),
)
