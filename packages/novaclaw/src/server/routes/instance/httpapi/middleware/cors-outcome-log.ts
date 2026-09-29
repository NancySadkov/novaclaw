import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Log } from "@novaclaw/schema/log"

/**
 * 🔴 RECORD EVERY CORS ANSWER, SO A REFUSED PREFLIGHT IS A MEASUREMENT RATHER THAN A GUESS.
 *
 * Measured 2026-09-29, packaged app 0.1.81. A client was refused with *"Response to preflight request
 * doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present"* on `/log`,
 * `/provider` and `/path` — and minutes later a live probe of those same routes, on the same port,
 * returned `204` with `Access-Control-Allow-Origin: nc://renderer`, including the `authorization`
 * preflight the renderer actually sends. The policy was correct, so something ELSE answered without
 * the header.
 *
 * Which layer did it is the whole question, and it was unanswerable: the server records what it
 * handled, so a preflight answered upstream of the CORS middleware — or by a second listener — leaves
 * no trace at all. The client's console is the only witness and it names the symptom, not the cause.
 *
 * This closes that gap. Every `OPTIONS` request is recorded with its origin, the method and headers it
 * asked for, the route, the status, and WHICH of four outcomes occurred:
 *
 *   - `allowed`     — answered with an allow-origin header (the boring majority, so `debug`)
 *   - `no-origin`   — no `Origin` at all, so CORS did not apply and the route answered on its own
 *   - `refused`     — an origin was present, CORS ran, and the policy said no. 2xx.
 *   - `passthrough` — an origin was present and the request left with NO allow-origin header and a
 *                     non-2xx status, i.e. CORS never ran for it. This is the shape the client reported,
 *                     and until now it was indistinguishable from `refused`.
 *
 * ⚠️ The status is what separates the last two, which is why it is recorded on all of them: 2xx with
 * an origin and no header is a policy decision, anything else is CORS being skipped.
 *
 * ⚠️ **A diagnostic, and it must outlive the next boot.** Remove it before a slow boot is explained
 * and the same mystery returns with the same absence of evidence. The success path is `debug` so it
 * costs nothing in a normal log; only the three unexpected shapes are `warn`.
 */
export const corsOutcomeLog = HttpRouter.middleware(
  (effect) =>
    Effect.gen(function* () {
      // The RESPONSE first, and the request only after it. A logging middleware that read the request
      // first could still throw before the inner effect ran, and would swallow the response it was
      // only supposed to observe — `disposeMiddleware` reads them in this order for the same reason.
      const response = yield* effect
      const request = yield* HttpServerRequest.HttpServerRequest
      if (request.method !== "OPTIONS") return response
      yield* record(request, response)
      return response
    }),
  { global: true },
)

const record = (
  request: HttpServerRequest.HttpServerRequest,
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<void> => {
  const origin = request.headers["origin"]
  const allowOrigin = response.headers["access-control-allow-origin"]
  const status = response.status
  const base = {
    "http.route": request.url,
    "http.cors.method": request.headers["access-control-request-method"],
    "http.cors.status": status,
  } as const
  const asked = { ...base, "http.cors.headers": request.headers["access-control-request-headers"] }

  if (!origin) return Log.event("http.cors.preflight.no-origin", base)
  if (allowOrigin) return Log.event("http.cors.preflight.allowed", { ...asked, "http.cors.origin": origin })
  const kind = status >= 200 && status < 300 ? "refused" : "passthrough"
  return Log.event(
    kind === "refused" ? "http.cors.preflight.refused" : "http.cors.preflight.passthrough",
    { ...asked, "http.cors.origin": origin },
  )
}
