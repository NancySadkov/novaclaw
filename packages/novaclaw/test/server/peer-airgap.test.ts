import { describe, expect, test } from "bun:test"
import { CommunityPeerPaths } from "../../src/server/routes/instance/httpapi/groups/community"
import { refusesWhileAirgapped } from "../../src/server/routes/instance/httpapi/middleware/peer-airgap"

/**
 * 🔴 Found by probing a running instance with the airgap engaged. `transport.state` reported
 * `{kind:"off", reason:"airgap"}` — the user was being TOLD the community was off — while an
 * anonymous request still received the full body of a channel message, byte-identical to the
 * airgap-off control, plus the user's offer (endpoint, models, Lightning address) and the list of
 * rooms this instance hosts.
 *
 * ⚠️ The design already intended this: `search.receive` checks the policy and answers nothing, and
 * the sync SENDING paths check it too. It was the receiving side of everything else that was missed,
 * which is what a cross-cutting rule applied service-by-service does — eleven handlers each had to
 * remember, and most did not. Hence a derived gate rather than eleven more `if`s.
 */
describe("airgap on the peer door", () => {
  test("🔴 every unauthenticated peer path is refused while airgapped, derived not listed", () => {
    for (const path of Object.values(CommunityPeerPaths))
      expect(refusesWhileAirgapped(path, true)).toBe(true)
  })

  test("a query string cannot smuggle a peer path past the gate", () => {
    expect(refusesWhileAirgapped(`${CommunityPeerPaths.syncMessages}?t=1`, true)).toBe(true)
  })

  test("🔴 with the airgap OFF nothing is refused — the control that matters", () => {
    // A gate that simply broke these endpoints would pass the test above and fail the product.
    for (const path of Object.values(CommunityPeerPaths))
      expect(refusesWhileAirgapped(path, false)).toBe(false)
  })

  test("🔴 the OWNER's own API is never gated, airgap or not", () => {
    /**
     * The airgap withdraws a choice to talk to the NETWORK. An airgap that locked the user out of
     * their own message history would be a data-loss bug wearing a security feature's clothes.
     */
    for (const path of [
      "/api/community/channel/%23bread/history",
      "/api/community/contact",
      "/api/session",
      /**
       * 🔴 The owner's own OFFER read. This gate broke it: the panel used to read the peer path
       * `/api/community/offer`, so an airgapped user could not see their own advertisement — and
       * this very test passed, because it only listed app paths and that read was not one. The fix
       * gave the owner their own route; the test now names it so the coupling cannot come back.
       */
      "/api/community/offer/mine",
    ])
      expect(refusesWhileAirgapped(path, true)).toBe(false)
  })
})
