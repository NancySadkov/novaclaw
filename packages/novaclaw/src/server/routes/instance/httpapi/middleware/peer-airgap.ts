import { Effect } from "effect"
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http"
import { CommunityConsent } from "@novaclaw/core/community/consent"
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

/**
 * 🔴 Whether a peer path is closed because this instance has not JOINED the community.
 *
 * The module is off until its owner accepts what joining costs — unmoderated content, and an IP
 * address revealed to whoever they talk to. Until then the peer door answers nothing, which is the
 * difference between "installed NovaClaw" and "is on the network".
 *
 * ⚠️ Deliberately the same door as the airgap check rather than a second middleware: both answer
 * "may a stranger reach us right now", and two gates over one surface is how one of them ends up
 * applied to a path the other is not — the service-by-service mistake that left the airgap off
 * every receiving handler but one.
 */
export const refusesWhileNotJoined = (url: string, participating: boolean): boolean => {
  if (participating) return false
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
    if (refusesWhileAirgapped(request.url, Offline.currentPolicy().enabled))
      return HttpServerResponse.text("Airgapped", { status: 503 })
    /**
     * ⚠️ Reported as its own status rather than folded into the line above: "this instance has not
     * joined the community" and "this instance is airgapped" are different facts about the far end,
     * and a peer that could not tell them apart would retry the wrong one forever.
     */
    if (refusesWhileNotJoined(request.url, CommunityConsent.participates(CommunityConsent.currentGate())))
      return HttpServerResponse.text("Community not enabled on this instance", { status: 503 })
    return yield* effect
  }),
).layer
