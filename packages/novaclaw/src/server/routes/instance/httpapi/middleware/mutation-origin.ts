import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CorsConfig, isAllowedRequestOrigin, type CorsOptions } from "@novaclaw/server/cors"

/**
 * 🔴 A state-changing request carrying a FOREIGN `Origin` is refused (p2p review 2026-08-17, 1.18).
 *
 * On a default install there is no password, so `ServerAuth.required` is false and every authorised
 * route answers anyone who can reach the port. Three things then line up into the CSRF shape:
 *
 *   · Effect's payload decoder defaults a MISSING content-type to `application/json`
 *     (`HttpApiBuilder.js:328`), so a "simple" cross-origin request is decoded normally;
 *   · Effect's CORS middleware only WITHHOLDS `access-control-allow-origin` — it never refuses, so
 *     the request has already executed by the time the browser discards the response;
 *   · nothing looked at `Origin` on mutations. `isAllowedRequestOrigin` existed and was used by
 *     exactly one caller, the PTY websocket.
 *
 * Measured live on the journey instance: `POST /api/community/channel` with
 * `Origin: https://evil.example` and no content-type → **200**, and `#csrf-live` appeared in the
 * channel list. The same shape reaches `/contact/:id/block`, `/channel/:name/post`, `/rotate`,
 * `/filter`, `/offer/mine` and `PATCH /config`.
 *
 * ⚠️ **What this does and does not change.** Ruling 5 already accepts that any local process can
 * drive a passwordless instance; that is not weakened and is not the point. What the probe widened
 * was "local process" to include *a web page open in a browser without Private Network Access* —
 * Chromium 148 blocked it, Safari/Firefox/older engines are unverified, and a boundary that holds
 * only on the engine we happened to test is not a boundary.
 *
 * ⚠️ **Absent `Origin` is ALLOWED, and that is deliberate rather than a hole.** Peers, the SDK,
 * `curl` and every non-browser caller send none, and refusing them would break the network to stop
 * an attack none of them can mount: the header is attacker-*uncontrollable* precisely in the browser
 * case this exists for. A page cannot suppress its own `Origin` on a state-changing fetch.
 *
 * ⚠️ Router-level, unlike the peer door beside it, and the reason is worth stating so the two are
 * not "fixed" into one shape later: the peer guard had to know WHICH route matched, which is why it
 * became group middleware. This one asks only about the method and two headers, so there is no route
 * set to get wrong — and it must cover every mutating route on the server, including the raw ones
 * that are not part of any `HttpApi` group.
 */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"])

/** The whole decision, pure, so it can be tested without standing up a server. */
export const refusesMutation = (input: {
  readonly method: string
  readonly origin: string | undefined
  readonly host: string | undefined
  readonly cors: CorsOptions | undefined
}): boolean =>
  MUTATING.has(input.method) && !isAllowedRequestOrigin(input.origin, input.host, input.cors)

export const mutationOriginLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const cors = yield* CorsConfig
    if (
      refusesMutation({
        method: request.method,
        origin: request.headers["origin"],
        host: request.headers["host"],
        cors,
      })
    )
      return HttpServerResponse.text("Forbidden origin", { status: 403 })
    return yield* effect
  }),
).layer
