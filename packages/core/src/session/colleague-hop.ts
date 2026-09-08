export * as ColleagueHop from "./colleague-hop"

import type { SessionMessage } from "./message"
import { ColleagueStall } from "./colleague-stall"
import { isSteerText } from "./steer-provenance"

/**
 * HOW FAR FROM A PERSON THIS TURN IS — read from the transcript already in hand.
 *
 * 🔴 **Free, and that is the point.** `notes/named-agents.md` flags withholding the colleague ops at
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
    // 🔴 An instance NOTICE is nobody's turn — step over it. It carries no origin (it is not a
    // colleague speaking), and without this the line below reads that as A PERSON speaking and
    // returns 0 — so the stall notice's own "ask again" handed out a fresh `HOP_CAP` every thirty
    // minutes and the cap could never fire. See `ColleagueStall.isNotice`.
    if (ColleagueStall.isNotice((message as { id?: string }).id)) continue
    // 🔴 A HARNESS STEER is nobody's turn either — step over it for the same reason. A doom-loop
    // redirect, a quality nudge or an introspection prompt is stored as a `user` message with no
    // origin, so the line below read it as A PERSON speaking and returned 0. The harness nudging a
    // model therefore handed it a fresh `HOP_CAP`, and a chain that had just been redirected — which
    // is precisely when a model is looping — was the one least likely to be stopped by the cap.
    //
    // `isSteerText` is the same test `isRealUserTurn` uses one module over; this walk simply never
    // asked it. See `steer-provenance.ts` for why a steer riding the user role is the shape that
    // keeps catching things out.
    if (isSteerText(message.text)) continue
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
