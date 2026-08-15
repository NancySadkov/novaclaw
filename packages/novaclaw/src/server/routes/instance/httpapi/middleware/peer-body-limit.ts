import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CommunityPeerPaths } from "../groups/community"

/**
 * 🔴 A size limit on the UNAUTHENTICATED community endpoints, applied before the body is read.
 *
 * Found by probing a running instance, and it sits BENEATH every other bound in this subsystem —
 * which is why none of them caught it. `MAX_BODY_BYTES` is 8 KB, `MAX_MESSAGES_PER_REQUEST` is 256,
 * `MAX_CHANNEL_BYTES` is 256; all of them are checked AFTER the body has been buffered and parsed.
 * Measured against a real server: a **52.9 MB** POST from an anonymous caller returned **200 OK** and
 * cost **+450 MB** of commit charge — an 8.5× amplification, for a request that costs the sender
 * almost nothing to send. The 8 KB message bound means nothing against that.
 *
 * ⚠️ Scoped to the PEER paths deliberately, not applied to the whole API. Those eleven routes are
 * the door anyone on the internet may knock on, and their legitimate maximum is known and small:
 * the largest is `sync/messages` at 256 ids of 64 hex characters, about 17 KB. The authenticated app
 * API is a different question with different traffic, and quietly capping it here would be a change
 * nobody asked for, discovered later as a mysterious failure.
 *
 * ⚠️ A request with no `content-length` is refused on these paths rather than read hopefully. It is
 * the only way the check can be made BEFORE the allocation it exists to prevent, and every real
 * caller here is our own transport, which sends a string body and therefore always sets the header.
 */
export const MAX_PEER_REQUEST_BYTES = 256 * 1024

const PEER_PATHS = new Set<string>(Object.values(CommunityPeerPaths))
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"])

/**
 * The whole decision, as a function, so it can be tested without standing up a server — and so the
 * peer path set is DERIVED from `CommunityPeerPaths` rather than hand-listed, which is the mistake
 * the `/api` auth guard made three times.
 */
export const refusesBody = (method: string, url: string, contentLength: string | undefined): boolean => {
  if (!BODY_METHODS.has(method)) return false
  // The path only — a query string must not be able to smuggle a route past the set.
  const path = url.split("?")[0] ?? url
  if (!PEER_PATHS.has(path)) return false
  const declared = Number(contentLength)
  return !Number.isFinite(declared) || declared > MAX_PEER_REQUEST_BYTES
}

export const peerBodyLimitLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    if (refusesBody(request.method, request.url, request.headers["content-length"]))
      return HttpServerResponse.text("Payload Too Large", { status: 413 })
    return yield* effect
  }),
).layer
