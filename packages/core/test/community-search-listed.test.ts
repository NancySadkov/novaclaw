import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityConsent } from "@novaclaw/core/community/consent"
import { CommunitySearch } from "@novaclaw/core/community/search"
import { CommunityWork } from "@novaclaw/core/community/work"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { testEffect } from "./lib/effect"

/**
 * 🔴 What a stranger's search may learn, and it is the property a design ruling rests on.
 *
 * Asked whether BLOCKING should extend to search, the answer is no — and it is only defensible
 * because of what is pinned here. Two facts together:
 *
 *   1. a search reveals ONLY rooms the user explicitly listed, so it discloses nothing private;
 *   2. `origin` is an UNVERIFIED string the caller writes, so a block on it costs one byte to evade.
 *
 * Demonstrated live at the peer endpoint: a blocked origin was still answered, and the same query
 * with one character of the origin changed was answered too. Adding the check would put protection
 * in the UI that does not exist, which is worse than its honest absence — so this test guards the
 * fact that makes the absence safe. **If an unlisted room ever appears here, that ruling is void.**
 */
const it = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, InstanceIdentityStore.node, CommunityChannels.node, CommunitySearch.node]),
  ),
)

const proven = (terms: string) => {
  const base = { id: `q-${terms}`, terms, ttl: 3, origin: `nid_${Buffer.alloc(32, 5).toString("base64url")}` }
  const nonce = CommunityWork.solve(CommunitySearch.workBytes(base))
  if (nonce === undefined) throw new Error("could not solve the query work")
  return { ...base, nonce }
}

describe("what a stranger's search can see", () => {
  it.effect("🔴 an UNLISTED room is never returned, even on its exact name", () =>
    Effect.gen(function* () {
      /**
       * ⚠️ This instance has JOINED. Search does not answer for one that has not — an instance whose
       * owner never accepted what joining costs neither speaks nor is spoken to — so without this
       * every case below returns empty and the test would pass for entirely the wrong reason: the
       * unlisted room would look protected when nothing was being searched at all.
       */
      CommunityConsent.applied({ consented: true }, { enabled: false })
      const channels = yield* CommunityChannels.Service
      const search = yield* CommunitySearch.Service

      yield* channels.join("#published")
      yield* channels.setListed("#published", true)
      yield* channels.join("#kept-private")

      // The CONTROL: listing is what makes a room findable, so the mechanism is known to work.
      expect(yield* search.receive(proven("published"))).toEqual(["#published"])

      // 🔴 And the room the user did NOT publish stays invisible — on its exact name, and on a
      // prefix, because a partial match that leaked it would be the same disclosure.
      expect(yield* search.receive(proven("kept-private"))).toEqual([])
      expect(yield* search.receive(proven("kept"))).toEqual([])

      // ⚠️ Un-listing takes it back out of view: the switch has to work in both directions, or a
      // user who changes their mind is told something false.
      yield* channels.setListed("#published", false)
      expect(yield* search.receive(proven("published"))).toEqual([])
    }).pipe(),
  )
})
