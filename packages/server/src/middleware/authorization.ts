import { ServerAuth } from "../auth"
import { UnauthorizedError } from "@novaclaw/protocol/errors"
import { Authorization } from "@novaclaw/protocol/middleware/authorization"
export { Authorization } from "@novaclaw/protocol/middleware/authorization"
import { hasFileReadTicketURL } from "@novaclaw/protocol/groups/fs"
import { hasPtyConnectTicketURL, isPtyConnectURL } from "@novaclaw/protocol/groups/pty"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
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
  // 🔴 A URL is not a credential channel. A secret that travels in one stops being a credential and
  // becomes data, so every component that forwards, logs or stores the URL does the same to the
  // secret — and every other route on this surface IS proxied to another machine. The WebSocket
  // upgrade is the one caller that structurally cannot set a header, so it is the one exception.
  if (isPtyConnectURL(url)) {
    const token = url.searchParams.get(AUTH_TOKEN_QUERY)
    if (token) return decodeCredential(token)
  }
  const match = /^Basic\s+(.+)$/i.exec(request.headers.authorization ?? "")
  if (match) return decodeCredential(match[1])
  return Effect.succeed(emptyCredential())
}

export const authorizationLayer = Layer.effect(
  Authorization,
  Effect.gen(function* () {
    const envConfig = yield* ServerAuth.Config
    const settings = yield* SettingsConfigStore.Service
    // Resolve the EFFECTIVE config per request (stored server.password → launcher default) so a
    // runtime token change takes authority immediately without a restart.
    return Authorization.of((effect) =>
      Effect.gen(function* () {
        const config = ServerAuth.effective(envConfig, yield* settings.serverPassword())
        if (!ServerAuth.required(config)) return yield* effect
        const request = yield* HttpServerRequest.HttpServerRequest
        // 🔴 THE TWO REQUESTS A BROWSER ISSUES ON ITS OWN, and they are the only ones exempted.
        // A WebSocket upgrade and a `<a download>` are both fetched by the browser rather than by
        // our client, so neither can carry `Authorization`; each instead presents a `ticket`
        // (`@novaclaw/core/ticket`) that names one target, works once and dies in a minute.
        //
        // ⚠️ **This admits the request; it does not authorize it.** Each handler is obliged to
        // CONSUME the ticket and refuse a request whose ticket does not match what it is being
        // asked for — `handlers/pty.ts` for the upgrade, `handlers/fs.ts` for the read. A handler
        // that skipped that step would make the predicate beside it an open door, which is why the
        // ticket suites assert a forged and an expired one are refused rather than only that a
        // fresh one works.
        const url = new URL(request.url, "http://localhost")
        if (hasPtyConnectTicketURL(url) || hasFileReadTicketURL(url)) return yield* effect
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
