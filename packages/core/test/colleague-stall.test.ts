import { describe, expect, test } from "bun:test"
import { ColleagueStall } from "@novaclaw/core/session/colleague-stall"

/**
 * An ask nobody answers must not strand the asker.
 *
 * A REFUSED hand-off is reported to the sender — that is what this programme spent a week building.
 * An ACCEPTED and never-answered one was silent, which is the stall mode that actually matters on a
 * real project: the asker sits on a promise it made to the user.
 */

const CHAT_OF = { aris: "ses_aris", theron: "ses_theron", kallias: "ses_kallias" }
const AGENT_OF = { ses_aris: "aris", ses_theron: "theron", ses_kallias: "kallias" }
/**
 * Every chat here was born before every ask in these tests, so the generation rule
 * (`stalled`'s `chatBornAt`) never fires unless a case is about to say it should. `born` overrides
 * it for the one case that IS about it.
 */
const CHAT_BORN_AT = { aris: 0, theron: 0, kallias: 0 }
const MINUTE = 60_000
const find = (input: {
  landed: ColleagueStall.Landed[]
  now: number
  after?: number
  born?: Record<string, number>
}) =>
  ColleagueStall.stalled({
    ...input,
    agentOf: AGENT_OF,
    chatOf: CHAT_OF,
    chatBornAt: { ...CHAT_BORN_AT, ...input.born },
  })

describe("which asks have gone unanswered", () => {
  test("a fresh ask is not a stall", () => {
    // The bound is on silence, not on asking.
    expect(find({ landed: [{ sessionID: "ses_theron", from: "aris", at: 0 }], now: 5 * MINUTE })).toEqual([])
  })

  test("🔴 an old ask with no reply is reported, naming both sides", () => {
    expect(find({ landed: [{ sessionID: "ses_theron", from: "aris", at: 0 }], now: 40 * MINUTE })).toEqual([
      { asker: "aris", colleague: "theron", askedAt: 0 },
    ])
  })

  test("an ANSWERED ask is never reported, however old", () => {
    // The reply is a later message from theron into aris's own chat.
    const landed = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_aris", from: "theron", at: 2 * MINUTE },
    ]
    expect(find({ landed, now: 10 * 60 * MINUTE })).toEqual([])
  })

  test("⚠️ ANY later message from that colleague counts as an answer", () => {
    // Not only one that parses as an answer. A stricter test would report a colleague that replied
    // in its own words as silent — the worst false alarm there is, because the asker can SEE the
    // answer sitting in its chat and would learn to distrust the notice.
    const landed = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_aris", from: "theron", at: MINUTE },
    ]
    expect(find({ landed, now: 90 * MINUTE })).toEqual([])
  })

  test("a reply that arrived BEFORE the ask does not silence it", () => {
    // Otherwise one old exchange between the same two silences every later ask forever.
    //
    // ⚠️ The kallias message is load-bearing, and writing this test without it taught me the rule:
    // with theron's reply as the LAST thing in aris's chat, aris writing back to theron is an ANSWER
    // by `turnFor`, not an ask — so there would be nothing to report and the test would be asserting
    // the wrong thing. Something else has to land first for aris's next message to be a fresh ask.
    const landed = [
      { sessionID: "ses_aris", from: "theron", at: 0 },
      { sessionID: "ses_aris", from: "kallias", at: 5 * MINUTE },
      { sessionID: "ses_theron", from: "aris", at: 10 * MINUTE },
    ]
    expect(find({ landed, now: 60 * MINUTE })).toContainEqual({
      asker: "aris",
      colleague: "theron",
      askedAt: 10 * MINUTE,
    })
  })

  test("a reply from someone ELSE does not answer it", () => {
    const landed = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_aris", from: "kallias", at: MINUTE },
    ]
    // ⚠️ `toContainEqual`, not `toEqual`: kallias writing to aris is ITSELF an ask nobody answered,
    // so the fixture legitimately holds two stalls. Asserting the whole list would have pinned an
    // accident of the fixture rather than the rule under test.
    expect(find({ landed, now: 60 * MINUTE })).toContainEqual({ asker: "aris", colleague: "theron", askedAt: 0 })
  })

  test("an asker with no chat is skipped — there is nowhere to tell it", () => {
    expect(
      ColleagueStall.stalled({
        landed: [{ sessionID: "ses_theron", from: "ghost", at: 0 }],
        agentOf: AGENT_OF,
        chatOf: CHAT_OF,
        chatBornAt: CHAT_BORN_AT,
        now: 60 * MINUTE,
      }),
    ).toEqual([])
  })

  test("🔴 an ask from BEFORE the asker's current chat is not outstanding in it", () => {
    // Owner report 2026-09-26: Daedalus was told "the message to nova you sent 1437 minutes ago is
    // still unanswered" in a chat created minutes earlier. The ask predated the chat — Clear chat had
    // archived the conversation the promise was made in — so nothing is outstanding in the new one.
    const landed = [{ sessionID: "ses_theron", from: "aris", at: 20 * MINUTE }]
    // Aris's chat was born AFTER the ask: a different generation.
    expect(find({ landed, now: 60 * MINUTE, born: { aris: 30 * MINUTE } })).toEqual([])
    // The same ask in the generation it was made in is still a stall — the rule is about the chat,
    // not about age.
    expect(find({ landed, now: 60 * MINUTE, born: { aris: 10 * MINUTE } })).toEqual([
      { asker: "aris", colleague: "theron", askedAt: 20 * MINUTE },
    ])
  })

  test("several outstanding asks are each reported", () => {
    const landed = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_kallias", from: "aris", at: MINUTE },
    ]
    expect(
      find({ landed, now: 60 * MINUTE })
        .map((s) => s.colleague)
        .sort(),
    ).toEqual(["kallias", "theron"])
  })

  test("🔴 MANY unanswered asks to ONE colleague are told ONCE, anchored on the oldest", () => {
    // Owner report 2026-09-26: a relaunch fired 33 backlogged notices into one chat, one per
    // historical ask. The unit is the PAIR — the colleague either answered or it did not.
    const landed = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_theron", from: "aris", at: 20 * MINUTE },
      { sessionID: "ses_theron", from: "aris", at: 25 * MINUTE },
    ]
    expect(find({ landed, now: 60 * MINUTE })).toEqual([{ asker: "aris", colleague: "theron", askedAt: 0 }])
  })
})

describe("telling the asker exactly once", () => {
  test("🔴 the notice id is DERIVED from the ask, so a second attempt collides", () => {
    // The tick fires every 30 s. Idempotency is the primary key refusing the second insert, rather
    // than a table we would have to keep in step with the notices actually sent.
    const ask = { asker: "aris", colleague: "theron", askedAt: 1234 }
    expect(ColleagueStall.noticeID(ask)).toBe(ColleagueStall.noticeID({ ...ask }))
    expect(ColleagueStall.noticeID(ask)).toStartWith("msg_")
  })

  test("🔴 the id is the PAIR — a moving anchor can never re-notice the same colleague", () => {
    // Owner, 2026-09-26: notices kept arriving at ~23h ages because `askedAt` was in the id, so as
    // the oldest unanswered ask aged out of the 24h lookback the anchor moved and a NEW id was
    // minted. One pair is one notice, whatever the anchor.
    expect(ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 1 })).toBe(
      ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 2 }),
    )
    expect(ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 1 })).not.toBe(
      ColleagueStall.noticeID({ asker: "aris", colleague: "kallias", askedAt: 1 }),
    )
  })

  test("the notice carries the colleague id and the ACTUAL wait, interpolated", () => {
    // Wording only changed; the name is the agent id the tool layer uses (owner, 2026-09-26), and the
    // minutes are the real elapsed value. Asserted EXACTLY so a future edit cannot go back to a
    // placeholder or swap in a display name.
    expect(ColleagueStall.notice({ asker: "aris", colleague: "theron", askedAt: 0, minutes: 31 })).toBe(
      "The message to theron you sent 31 minutes ago is still unanswered. " +
        "If you promised this answer to someone, report back, then ask again, do it yourself, or tell " +
        "your superior it is outstanding.",
    )
  })

  test("the threshold is a CEILING, not an estimate of a healthy reply", () => {
    // Chosen to be un-hittable by a working exchange: an ask still wakes its recipient, so a healthy
    // answer is one turn away rather than one dormant chat away.
    expect(ColleagueStall.AFTER_MS).toBeGreaterThanOrEqual(30 * MINUTE)
  })
})
