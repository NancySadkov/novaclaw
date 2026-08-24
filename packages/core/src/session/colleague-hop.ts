export * as ColleagueHop from "./colleague-hop"

import type { SessionMessage } from "./message"

/**
 * HOW FAR FROM A PERSON THIS TURN IS — read from the transcript already in hand.
 *
 * 🔴 **Free, and that is the point.** `todo/named-agents.md` flags withholding the colleague ops at
 * the hop cap with a warning to *"measure what that costs per turn, since the hop is a
 * `lastPeerContext` read and materialisation is on the hot path"*. It is not a read at all: the
 * runner already holds the turn's messages there — the gate immediately above tool materialisation
 * calls `lastRealUserText(context)` over the same array — and `SessionMessage.User` carries the
 * `origin` that `hops` rides on. So the answer is a backwards walk over memory, not a query.
 *
 * ⚠️ **Absent means ZERO, not unknown.** A message with no peer origin is a person talking, and a
 * writer that predates the counter produced no hops either. Both are hop zero, which is the
 * permissive reading — the bound must never refuse a turn because it could not tell how deep it was.
 *
 * ⚠️ Reads the NEWEST peer turn rather than summing: `hops` is stamped by the sender as an absolute
 * depth (`ColleagueBound.nextHop`), so the latest message already carries the whole chain's length.
 * Adding them up would count the same chain once per message in it.
 */
export const fromContext = (context: readonly SessionMessage.Message[]): number => {
  for (let index = context.length - 1; index >= 0; index -= 1) {
    const message = context[index]
    if (message?.type !== "user") continue
    const origin = (message as { origin?: { via?: string; hops?: number } }).origin
    if (origin?.via !== "agent") {
      // A REAL person's turn ends the walk: anything older belongs to a previous exchange, and a
      // chain does not survive the user speaking. This is what stops an old deep hand-off from
      // holding a session at the cap forever.
      return 0
    }
    return typeof origin.hops === "number" && Number.isFinite(origin.hops) ? origin.hops : 0
  }
  return 0
}
