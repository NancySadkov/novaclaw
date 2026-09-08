export * as CommunityStanding from "./standing"

import { Effect } from "effect"
import { CommunityContacts } from "./contacts"
import { CommunityObservation } from "./observation"
import { CommunityPeers } from "./peers"

/**
 * 🔴 **The four rungs, and the ladder does not extend** (`AGENTS.md`, *Trust: a guru at the top*).
 *
 *     your own dealings  >  the doorman who let you in  >  judges it vouched for  >  anyone else
 *
 * This module answers ONE question — which rung is this peer on — and deliberately answers nothing
 * else. It computes no score, keeps no history and returns no number: the honesty ledger is an
 * experiment, and a permanent numerical reputation formula smuggled into an admission path would
 * outlive every decision anyone made about it (Codex review P1's own warning).
 *
 * 🔴 **Non-transitive by construction.** `vouched` is reachable only from a doorman the USER named;
 * a peer introduced by a vouched peer is a stranger, because a judge's own recommendation does not
 * create a fifth rung. The obvious implementation — walk `introducedBy` upward until you find
 * somebody trusted — is exactly the transitive ladder the design refuses, and it is one line away at
 * all times. There is no walk here.
 */
export type Rung = "own" | "doorman" | "vouched" | "stranger"

/** Ordered strongest first, so a caller can compare rungs without hard-coding the ladder. */
export const RUNGS: ReadonlyArray<Rung> = ["own", "doorman", "vouched", "stranger"]

export interface Stores {
  readonly contacts: CommunityContacts.Interface
  readonly peers: CommunityPeers.Interface
  readonly observations: CommunityObservation.Interface
}

/**
 * Which rung this peer stands on, right now.
 *
 * ⚠️ Recomputed per call rather than stored. A rung is a fact about the relationship TODAY: a
 * stranger who answers a question becomes somebody we have dealt with, and a stored rung would keep
 * calling them a stranger for as long as the row lived.
 */
export const rungOf = (stores: Stores, networkID: string): Effect.Effect<Rung> =>
  Effect.gen(function* () {
    /**
     * 🔴 OWN DEALINGS FIRST, and they outrank everything — including a block, which is not this
     * function's business: `allowed` refuses a blocked peer before it ever asks for a rung.
     *
     * The observation store holds only what THIS instance witnessed (hearsay is never stored as
     * fact), so a row here means we dealt with them ourselves. It resolves through the succession
     * chain, which is what stops a rotation from demoting somebody we know.
     */
    if (yield* stores.observations.has(networkID)) return "own"

    const contact = yield* stores.contacts.get(networkID)
    /**
     * 🔴 THE DOORMAN is a declaration the USER made — a contact they added and rated. It is not
     * inferred from traffic, because the whole point of the root is that a person chose it.
     */
    if (contact?.trust !== undefined && contact.trust > 0) return "doorman"

    /**
     * The third rung: introduced by a doorman, by that doorman's own answer to a peer exchange.
     *
     * ⚠️ ONE HOP, checked against the doorman set itself rather than by climbing. See the file
     * comment — this is the line that must never become a loop.
     */
    const row = yield* stores.peers.get(networkID)
    if (row?.introducedBy !== undefined) {
      const introducer = yield* stores.contacts.get(row.introducedBy)
      if (introducer?.trust !== undefined && introducer.trust > 0) return "vouched"
    }

    return "stranger"
  })

/**
 * 🔴 **Is there anybody for a reservation to be FOR?**
 *
 * A share kept back for higher rungs is a reservation; on an instance that knows nobody, it is
 * simply a refusal. And that is the ordinary case rather than a corner: a fresh install has no
 * contacts, so EVERY asker is a stranger, and a flat 25% would strand three quarters of the day's
 * budget where nothing could ever claim it. The user would watch their instance refuse questions it
 * was perfectly willing and able to answer.
 *
 * ⚠️ So the ceiling applies only once the user has an address book. A contact is the user's own
 * deliberate act — it is where both `doorman` and, in practice, `own` begin — and until there is
 * one, a stranger is not competing with anybody.
 *
 * ⚠️ Errs toward SERVING. An instance whose only known peers are unrated peer-exchange rows we have
 * dealt with reads as "no standing" here and answers strangers freely; the alternative error is
 * refusing on behalf of a beneficiary who does not exist, and of the two that is the one a user
 * would call a bug.
 */
export const hasStanding = (stores: Stores): Effect.Effect<boolean> =>
  Effect.map(stores.contacts.list(), (contacts) => contacts.length > 0)
