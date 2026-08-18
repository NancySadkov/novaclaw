import { Effect, Layer, Option } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { CommunityAdmission } from "@novaclaw/core/community/admission"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { Offline } from "@novaclaw/core/offline"

/**
 * 🔴 THE door strangers knock on — consent, airgap and size, on the MATCHED ROUTE.
 *
 * ## Why this is one middleware on a group rather than three checks on a URL
 *
 * This replaces `peer-airgap.ts` and `peer-body-limit.ts`, which decided by exact string equality
 * of `request.url` against `CommunityPeerPaths`. The router does not match that way. Measured on a
 * never-consented fresh instance during the 2026-08-17 review (finding 1.1):
 *
 *   /api/community/identity   → 503 "Community not enabled"   ← the guard saw the string it knew
 *   /api/community/identity/  → 200 with the instance identity
 *   /API/community/identity   → 200
 *   //api/community/identity  → 200
 *   identit%79                → 200
 *   POST /api/community/ask/ with 300 KB → fully buffered and parsed (500) instead of 413
 *
 * `find-my-way-ts@0.1.6` defaults to `ignoreTrailingSlash`, `ignoreDuplicateSlashes`,
 * `caseSensitive: false` and percent-decoding, and `RouterConfig` was never overridden — so the set
 * of strings that REACH a peer handler is unbounded while the set the guards recognised was twelve.
 * Spec 328–332 ("503 on every peer path until joined") was false as stated, and the airgap leak
 * `peer-airgap.ts` was written to close was back through any alias.
 *
 * ⚠️ The general lesson, and the reason this is not fixed by normalising the string: **a guard that
 * re-derives the router's decision is a second router**, and the two agree only until one of them is
 * configured. Membership in the `communityPeer` GROUP is the condition, so a door added later
 * inherits every rule here by existing, and no spelling can be outside a set that is not a set.
 *
 * ⚠️ Only the peer group. The authenticated app API is how the user reaches their own instance, and
 * an airgap that locked the owner out of their own history would be a data-loss bug wearing a
 * security feature's clothes — the airgap withdraws a choice to talk to the NETWORK, nothing else.
 * That separation is now structural rather than a path list that had to stay in sync with one.
 */
export class PeerDoor extends HttpApiMiddleware.Service<PeerDoor>()("@novaclaw/CommunityPeerDoor") {}

/**
 * 🔴 A size limit applied BEFORE the body is read.
 *
 * It sits beneath every other bound in this subsystem, which is why none of them caught it:
 * `MAX_BODY_BYTES` is 8 KB, `MAX_MESSAGES_PER_REQUEST` is 256, `MAX_CHANNEL_BYTES` is 256 — all
 * checked AFTER the body has been buffered and parsed. Measured against a real server: a 52.9 MB
 * POST from an anonymous caller returned 200 OK and cost +450 MB of commit charge, an 8.5×
 * amplification for a request that costs the sender almost nothing.
 *
 * ⚠️ This middleware wraps the whole endpoint effect — payload decoding included — so returning
 * here is what stops the allocation. Checking after `HttpApiBuilder` decodes the payload would be a
 * bound reported to an attacker after they had already spent our memory.
 */
export const MAX_PEER_REQUEST_BYTES = 256 * 1024

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"])

/**
 * The size decision, as a function, so it can be tested without standing up a server.
 *
 * ⚠️ No URL parameter any more, and that absence IS the fix for 1.1: this is only ever asked about a
 * request the router already matched to a peer endpoint.
 *
 * ⚠️ A request with no `content-length` is refused rather than read hopefully. It is the only way
 * the check can be made BEFORE the allocation it exists to prevent, and every real caller here is
 * our own transport, which sends a string body and therefore always sets the header.
 */
export const refusesBody = (method: string, contentLength: string | undefined): boolean => {
  if (!BODY_METHODS.has(method)) return false
  const declared = Number(contentLength)
  return !Number.isFinite(declared) || declared > MAX_PEER_REQUEST_BYTES
}

export const peerDoorLayer = Layer.succeed(PeerDoor)(
  PeerDoor.of((handler) =>
    Effect.gen(function* () {
      /**
       * ⚠️ `currentPolicy()`/`currentGate()` rather than the services, for two reasons. They are the
       * same process-wide refs the services' getters read, so engaging the airgap or withdrawing
       * consent in Settings takes effect at once instead of at the next boot — the property
       * `config-store-write` exists to guarantee. And requiring a service here would put an
       * `Offline` dependency on every peer endpoint, where building it from a parameter mints a
       * fresh memo key and quietly gives you a SECOND instance.
       */
      if (Offline.currentPolicy().enabled) return HttpServerResponse.text("Airgapped", { status: 503 })
      /**
       * ⚠️ Reported as its own status rather than folded into the line above: "this instance has not
       * joined the community" and "this instance is airgapped" are different facts about the far
       * end, and a peer that could not tell them apart would retry the wrong one forever.
       */
      if (!CommunityConsent.participates(CommunityConsent.currentGate()))
        return HttpServerResponse.text("Community not enabled on this instance", { status: 503 })
      const request = yield* HttpServerRequest.HttpServerRequest
      if (refusesBody(request.method, request.headers["content-length"]))
        return HttpServerResponse.text("Payload Too Large", { status: 413 })

      /**
       * 🔴 The ingress governor, BEFORE the handler and therefore before any database read (Codex
       * P1). The read-shaped peer doors pay no proof-of-work — deliberately, since catching up must
       * be cheap — and they amplify: ~335 KB from `/sync/ids` for a ~200-byte request, a 64-bucket
       * digest recomputed over 5,000 ids on every `/sync/summary`. The body cap bounds one
       * request's size and says nothing about their number.
       *
       * ⚠️ The SOURCE is the remote address, and its absence is treated as one shared bucket rather
       * than as an exemption: an unknown origin must not be the cheapest way past the limiter.
       */
      const source = Option.getOrElse(request.remoteAddress ?? Option.none(), () => "unknown")
      const state = CommunityAdmission.current()
      const refusal = CommunityAdmission.admit(state, source, Date.now())
      if (refusal !== undefined)
        return HttpServerResponse.text(refusal === "busy" ? "Too many requests in flight" : "Too many requests", {
          status: 429,
          headers: { "retry-after": "60" },
        })
      /**
       * ⚠️ `ensuring`, not a release after `handler`: an endpoint that fails, dies or is interrupted
       * must still give its slot back, or the concurrency ceiling ratchets down to zero and the
       * instance stops answering peers entirely — a self-inflicted outage wearing a limiter's hat.
       */
      return yield* handler.pipe(Effect.ensuring(Effect.sync(() => CommunityAdmission.release(state))))
    }),
  ),
)
