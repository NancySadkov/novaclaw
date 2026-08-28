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
const MINUTE = 60_000
const find = (input: { landed: ColleagueStall.Landed[]; now: number; after?: number }) =>
  ColleagueStall.stalled({ ...input, agentOf: AGENT_OF, chatOf: CHAT_OF })

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
        now: 60 * MINUTE,
      }),
    ).toEqual([])
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
})

describe("telling the asker exactly once", () => {
  test("🔴 the notice id is DERIVED from the ask, so a second attempt collides", () => {
    // The tick fires every 30 s. Idempotency is the primary key refusing the second insert, rather
    // than a table we would have to keep in step with the notices actually sent.
    const ask = { asker: "aris", colleague: "theron", askedAt: 1234 }
    expect(ColleagueStall.noticeID(ask)).toBe(ColleagueStall.noticeID({ ...ask }))
    expect(ColleagueStall.noticeID(ask)).toStartWith("msg_")
  })

  test("a DIFFERENT ask to the same colleague gets its own notice", () => {
    // Otherwise the second time aris is left hanging by theron, it is never told.
    expect(ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 1 })).not.toBe(
      ColleagueStall.noticeID({ asker: "aris", colleague: "theron", askedAt: 2 }),
    )
  })

  test("the notice says what to DO — it is not a bare complaint", () => {
    const text = ColleagueStall.notice({ asker: "aris", colleague: "theron", askedAt: 0, minutes: 31 })
    expect(text).toContain("theron")
    expect(text).toContain("31 minutes")
    // ⚠️ Obeys the wake discipline in its wording as well as its delivery: nobody is waiting on the
    // asker, so this must not read as a summons.
    expect(text).toContain("Nobody is waiting on you")
    expect(text).toMatch(/ask again|tell the user/)
  })

  test("the threshold is a CEILING, not an estimate of a healthy reply", () => {
    // Chosen to be un-hittable by a working exchange: an ask still wakes its recipient, so a healthy
    // answer is one turn away rather than one dormant chat away.
    expect(ColleagueStall.AFTER_MS).toBeGreaterThanOrEqual(30 * MINUTE)
  })
})
