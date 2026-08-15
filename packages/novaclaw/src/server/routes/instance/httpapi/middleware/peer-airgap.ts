import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { Offline } from "@novaclaw/core/offline"
import { CommunityPeerPaths } from "../groups/community"

/**
 * 🔴 The airgap, applied to the doors STRANGERS knock on.
 *
 * Found by probing a running instance with the airgap engaged. `transport.state` reported
 * `{kind:"off", reason:"airgap"}` — the user was being told the community was off — while an
 * anonymous request still received:
 *
 *   - the full BODY of a channel message, byte-identical to the airgap-off control
 *   - the user's offer: endpoint, model list and Lightning payment address
 *   - the list of rooms this instance hosts
 *
 * ⚠️ The design already intends this: `search.receive` checks the policy and answers nothing, and
 * the sync SENDING paths check it too. It was the receiving side of everything else that was missed
 * — which is what happens when a cross-cutting rule is applied service by service. Eleven handlers
 * each had to remember, and most did not.
 *
 * So the gate lives here instead, derived from `CommunityPeerPaths`, where a peer endpoint added
 * later inherits it rather than having to remember it.
 *
 * ⚠️ Only the PEER paths. The authenticated app API is how the user reaches their own instance, and
 * an airgap that locked the owner out of their own history would be a data-loss bug wearing a
 * security feature's clothes — the airgap withdraws a choice to talk to the NETWORK, nothing else.
 */
const PEER_PATHS = new Set<string>(Object.values(CommunityPeerPaths))

/** Whether this request is one the airgap should refuse. Pure, so it can be tested directly. */
export const refusesWhileAirgapped = (url: string, airgapped: boolean): boolean => {
  if (!airgapped) return false
  // The path only — a query string must not smuggle a route past the set.
  const path = url.split("?")[0] ?? url
  return PEER_PATHS.has(path)
}

export const peerAirgapLayer = HttpRouter.middleware<{ handles: unknown }>()((effect) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    /**
     * ⚠️ `currentPolicy()` rather than `Offline.Service`, for two reasons. It is the same
     * process-wide ref the service's getter reads, so engaging the airgap in Settings takes effect
     * at once instead of at the next boot — the property `config-store-write` exists to guarantee.
     * And requiring a service here would put an `Offline` dependency on the whole router, where
     * building it from a parameter mints a fresh memo key and quietly gives you a SECOND instance.
     */
    if (!refusesWhileAirgapped(request.url, Offline.currentPolicy().enabled)) return yield* effect
    return HttpServerResponse.text("Airgapped", { status: 503 })
  }),
).layer
