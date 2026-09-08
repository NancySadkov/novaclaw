import { describe, expect, test } from "bun:test"
import { ColleagueHop } from "@novaclaw/core/session/colleague-hop"
import { ColleagueStall } from "@novaclaw/core/session/colleague-stall"
import { STEER_PROVENANCE_PREFIX } from "@novaclaw/core/session/steer-provenance"

/**
 * THE NOTICE MUST NOT RESET THE BOUND IT POLICES.
 *
 * The item's falsification, verbatim: *"a stalled three-hop chain lands the notice WITHOUT the next
 * hop reading 0."*
 *
 * A stall notice is admitted with NO origin — deliberately, because it is the instance reporting
 * silence, and giving it a peer origin would make it answerable and count it as a hop. But both hop
 * walks read "user-role message, no agent origin" as A REAL PERSON SPEAKING, which ends the chain.
 * So the notice that says *"ask again"* handed the asker a fresh `HOP_CAP` budget every thirty
 * minutes, for ever — an unbounded re-ask loop invisible to the cap, the path and the rate window,
 * manufactured by the thing meant to REPORT the stall.
 */

const peerTurn = (hops: number) => ({
  id: "msg_peer_1",
  type: "user" as const,
  text: "the ledger?",
  origin: { via: "agent", relation: "peer", label: "theron", hops },
})

const noticeTurn = () => ({
  id: ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 1234 }),
  type: "user" as const,
  text: "[theron has not answered you.]",
})

const personTurn = () => ({ id: "msg_user_1", type: "user" as const, text: "carry on" })

describe("what a stall notice does to the chain", () => {
  test("🔴 a three-hop chain SURVIVES the notice landing on top of it", () => {
    expect(ColleagueHop.fromContext([peerTurn(3), noticeTurn()] as never)).toBe(3)
  })

  test("🔴 …and without the fix it read 0 — the control, stated as the bug", () => {
    // The identical shape with a REAL person's turn instead of the notice. This is what the walk
    // used to see in both cases, and why the cap could never fire.
    expect(ColleagueHop.fromContext([peerTurn(3), personTurn()] as never)).toBe(0)
  })

  test("a REAL person still ends the chain — the notice fix must not break that", () => {
    // The whole reason the reset exists: a chain does not survive the user speaking, or an old deep
    // hand-off holds a session at the cap for ever.
    expect(ColleagueHop.fromContext([peerTurn(4), personTurn(), noticeTurn()] as never)).toBe(0)
  })

  test("several notices in a row still do not reset it", () => {
    // The actual failure mode was repetition: one notice every thirty minutes, each one a reset.
    expect(ColleagueHop.fromContext([peerTurn(2), noticeTurn(), noticeTurn()] as never)).toBe(2)
  })

  test("a notice over an empty chat is still 0 — it invents no chain", () => {
    expect(ColleagueHop.fromContext([noticeTurn()] as never)).toBe(0)
  })
})

describe("recognising a notice", () => {
  test("the predicate matches what `noticeID` mints, and nothing else", () => {
    expect(ColleagueStall.isNotice(ColleagueStall.noticeID({ asker: "a", colleague: "b", askedAt: 1 }))).toBe(true)
    expect(ColleagueStall.isNotice("msg_in_aris_ses_theron_1")).toBe(false)
    expect(ColleagueStall.isNotice("msg_user_1")).toBe(false)
    expect(ColleagueStall.isNotice(undefined)).toBe(false)
  })

  test("⚠️ the prefix is the one `noticeID` actually uses", () => {
    // Keyed on an id, so a rename of one without the other silently stops the skip — and the symptom
    // would be the ORIGINAL bug returning, quietly.
    expect(ColleagueStall.noticeID({ asker: "a", colleague: "b", askedAt: 1 })).toStartWith(
      ColleagueStall.NOTICE_PREFIX,
    )
  })
})

/**
 * A HARNESS STEER MUST NOT RESET IT EITHER.
 *
 * The item's other clause, verbatim: *"steers reset it identically, including the withhold-at-cap
 * gate."* A doom-loop redirect, a quality nudge or an introspection prompt is stored as a `user`
 * message with no origin — the same shape the stall notice had — so the walk read it as a person
 * speaking and returned 0.
 *
 * 🔴 The timing is what makes it bite: the harness steers a model when it is LOOPING, so the
 * chain most in need of the cap was the one guaranteed to have its count wiped.
 */
const steerTurn = () => ({ id: "msg_steer_1", type: "user" as const, text: `${STEER_PROVENANCE_PREFIX}wrap it up` })

describe("what a harness steer does to the chain", () => {
  test("🔴 a three-hop chain SURVIVES a steer landing on top of it", () => {
    expect(ColleagueHop.fromContext([peerTurn(3), steerTurn()] as never)).toBe(3)
  })

  test("⚠️ …and a REAL person still ends it — the steer fix must not break the reset", () => {
    expect(ColleagueHop.fromContext([peerTurn(3), steerTurn(), personTurn()] as never)).toBe(0)
  })

  test("a steer and a notice together still preserve the chain", () => {
    // Both are the instance talking. Neither is a turn.
    expect(ColleagueHop.fromContext([peerTurn(2), steerTurn(), noticeTurn()] as never)).toBe(2)
  })

  test("⚠️ an ordinary user turn whose text merely MENTIONS a steer is not one", () => {
    // The prefix is a provenance marker, not a phrase. A person quoting it is still a person.
    const quoting = { id: "msg_user_2", type: "user" as const, text: `I saw ${STEER_PROVENANCE_PREFIX} in the log` }
    expect(ColleagueHop.fromContext([peerTurn(3), quoting] as never)).toBe(0)
  })
})
