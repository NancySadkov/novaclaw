import { describe, expect, test } from "bun:test"
import { ColleagueStall } from "@novaclaw/core/session/colleague-stall"

/**
 * AN ANNOUNCE COPY IS NOT AN UNANSWERED ASK.
 *
 * A conference reply is copied to every bystander so the room stays a room, and those copies were
 * byte-identical to an ask — same `via`, same `relation: "peer"`, same label — with the difference
 * living only in the NOTE's wording, which nothing downstream reads.
 *
 * So every reply in a ≥3-party room minted a FALSE stall per bystander: each one who correctly said
 * nothing looked like a colleague ignoring a question. The notice's own *"ask again"* then woke the
 * room — the exact amplification the announce discipline exists to remove — and a notice that fires
 * on healthy traffic teaches models to ignore notices, which `AFTER_MS`'s comment calls fatal.
 */

const CHAT_OF = { aris: "ses_aris", theron: "ses_theron", kallias: "ses_kallias" }
const AGENT_OF = { ses_aris: "aris", ses_theron: "theron", ses_kallias: "kallias" }
const MINUTE = 60_000
const find = (landed: ColleagueStall.Landed[]) =>
  ColleagueStall.stalled({ landed, agentOf: AGENT_OF, chatOf: CHAT_OF, now: 90 * MINUTE })

describe("a three-party room", () => {
  test("🔴 a bystander's silence is NOT a stall", () => {
    // aris asked the room; theron replied; the reply was COPIED to kallias to keep them informed.
    // kallias owes nobody an answer, so nothing is stalled.
    const landed: ColleagueStall.Landed[] = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_kallias", from: "aris", at: 0 },
      { sessionID: "ses_aris", from: "theron", at: 5 * MINUTE },
      { sessionID: "ses_kallias", from: "theron", at: 5 * MINUTE, announce: true },
    ]
    expect(find(landed).map((s) => `${s.asker}->${s.colleague}`)).toEqual(["aris->kallias"])
  })

  test("🔴 …and without the mark, theron is falsely reported as stalled BY kallias", () => {
    // The control: the identical fixture with the announce flag dropped — the bug, stated.
    const landed: ColleagueStall.Landed[] = [
      { sessionID: "ses_theron", from: "aris", at: 0 },
      { sessionID: "ses_kallias", from: "aris", at: 0 },
      { sessionID: "ses_aris", from: "theron", at: 5 * MINUTE },
      { sessionID: "ses_kallias", from: "theron", at: 5 * MINUTE },
    ]
    expect(find(landed).map((s) => `${s.asker}->${s.colleague}`)).toContain("theron->kallias")
  })

  test("a REAL ask to the same bystander is still reported", () => {
    // The announce mark must not become a way to silence genuine stalls: theron asking kallias
    // directly, in the same room, still counts.
    const landed: ColleagueStall.Landed[] = [
      { sessionID: "ses_kallias", from: "theron", at: 5 * MINUTE, announce: true },
      { sessionID: "ses_kallias", from: "theron", at: 10 * MINUTE },
    ]
    expect(find(landed).map((s) => `${s.asker}->${s.colleague}`)).toContain("theron->kallias")
  })

  test("an ordinary 1:1 ask is untouched by the field's existence", () => {
    expect(find([{ sessionID: "ses_theron", from: "aris", at: 0 }])).toEqual([
      { asker: "aris", colleague: "theron", askedAt: 0 },
    ])
  })

  test("⚠️ absent means a REAL hand-off, so every message written before the field reads as an ask", () => {
    // The permissive direction is the wrong one here — a stall missed is better than a stall
    // invented — but it must be the DELIBERATE direction, not an accident of `undefined`.
    const landed: ColleagueStall.Landed[] = [{ sessionID: "ses_theron", from: "aris", at: 0, announce: undefined }]
    expect(find(landed).length).toBe(1)
  })
})
