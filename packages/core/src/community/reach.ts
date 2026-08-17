export * as CommunityReach from "./reach"

import { Effect } from "effect"
import { CommunityContacts } from "./contacts"
import { CommunityPeers } from "./peers"
import { CommunityRoute } from "./route"

/**
 * 🔴 **THE list of places this instance may dial — one builder, every dialler.**
 *
 * P2P review 2026-08-17, findings 1.9 and 1.14. Six broadcast paths each assembled their own list by
 * unioning `contacts.bootstrap()` (which honours the user's block) with `peers.list()` (which does
 * not), so:
 *
 *   · a BLOCKED peer was dialled from the peers table — observed on the wire: `discover`, `search`,
 *     and `transport.publish` → `POST /blocked/api/community/inbound` carrying the user's own
 *     message. The block reached the half it was written on and no further;
 *   · `search.ts` read `peers.list()` ONLY, so it never asked the user's own contacts. A fresh
 *     install whose single entry point is a hand-added contact got empty search results until peer
 *     exchange happened to return that peer — dialling the untrusted table while skipping the
 *     trusted one.
 *
 * ⚠️ `dialableRoutes` already existed as "the §5(i) fix" and had two callers. **Fixing it in one
 * place is not a mechanism when six other places build their own** — which is this subsystem's
 * recurring failure (blocking missed two doors, the airgap missed ten). So the list lives here, the
 * diallers call it, and a source ledger asserts nobody re-derives it from `peers.list()`.
 */

export interface Reachable {
  readonly networkID: string
  /** Canonical and already validated by `CommunityRoute.dialable`. */
  readonly route: string
}

/**
 * Everywhere we might reach the network: the user's contacts FIRST, then merely-known peers.
 *
 * ⚠️ Contacts first because the caller's cap cuts the tail — the people the user actually added must
 * survive a slice that a table filled by strangers would otherwise crowd out.
 *
 * ⚠️ Carries the IDENTITY beside each route. An earlier version flattened to URLs, and that loss was
 * not cosmetic: eviction is least-recently-SEEN first, so without knowing whose route answered there
 * is nothing to mark, `last_seen_at` stays null forever, and invented peers evict working ones.
 */
export const reachable = Effect.fn("CommunityReach.reachable")(function* (input: {
  /**
   * ⚠️ The two stores are PASSED, not resolved from context, and that is a requirement rather than a
   * style: every caller is inside a `Layer.effect` that already holds them, and a service resolved
   * here would have to be in the RUNTIME context of whoever calls the built function — which it is
   * not. (Building one from a parameter would also mint a fresh memo key and quietly give you a
   * second store; see `effect-memomap-keyed-on-layer-identity`.)
   */
  readonly contacts: CommunityContacts.Interface
  readonly peers: CommunityPeers.Interface
  /** Keep at most this many DISTINCT routes. Applied after de-duplication, so it counts boxes. */
  readonly limit?: number
  /** Only this peer's routes — the direct-send case. */
  readonly only?: string
}) {
  const { contacts, peers } = input
  /**
   * 🔴 The block is applied to BOTH tables here, once.
   *
   * `bootstrap()` filters its own rows, but a peer met on the LAN, through peer exchange or through
   * the DHT lives in the PEERS table, which carries no `blocked` column — the block is a fact about
   * a PERSON, and the person is the key. So the blocked set is read from contacts and applied to
   * every row whatever table it came from.
   */
  const blocked = new Set(
    (yield* contacts.list()).filter((entry) => entry.blocked === true).map((entry) => entry.networkID),
  )
  const known = yield* contacts.bootstrap()
  const learned = yield* peers.list()

  const out: Reachable[] = []
  const already = new Set<string>()
  for (const entry of [...known, ...learned]) {
    if (blocked.has(entry.networkID)) continue
    if (input.only !== undefined && entry.networkID !== input.only) continue
    // Validated AGAIN on the way out: rows written before the validator existed are still in the
    // table, and `sample` hands them onwards. See `route.ts`.
    for (const route of CommunityRoute.dialableAll(entry.routes)) {
      if (already.has(route)) continue
      already.add(route)
      out.push({ networkID: entry.networkID, route })
    }
  }
  return input.limit === undefined ? out : out.slice(0, input.limit)
})

/** Every address we may dial for ONE peer — `sendDirect`'s and `askPeer`'s question. */
export const routesFor = Effect.fn("CommunityReach.routesFor")(function* (input: {
  readonly contacts: CommunityContacts.Interface
  readonly peers: CommunityPeers.Interface
  readonly to: string
}) {
  return (yield* reachable({ contacts: input.contacts, peers: input.peers, only: input.to })).map(
    (entry) => entry.route,
  )
})
