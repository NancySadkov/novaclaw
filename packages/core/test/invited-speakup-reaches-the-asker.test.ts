import { describe, expect, test } from "bun:test"
import { ColleagueBound } from "@novaclaw/core/session/colleague-bound"

/**
 * THE INVITED SPEAK-UP MUST REACH THE PERSON WHO ASKED.
 *
 * A bystander's own note tells it that it may address the room. But every participant is already ON
 * the path — that is how they were reached — so `closesCycle` dropped the ORIGINATOR as a loop. The
 * room invited a reply and then refused to deliver it to the one person it was for, and the
 * bystander could not tell: its message was accepted for everyone else.
 *
 * `answering` does not cover it. That exempts the single party you are replying to, and a bystander
 * taking up an invitation is not replying to the asker.
 */

const ROOM = ["aris", "theron", "kallias"]

describe("a bystander answering the room", () => {
  test("🔴 reaches the ORIGINATOR, who is on the path", () => {
    // aris asked the room; the chain went aris → theron → kallias, so aris is on kallias's path.
    expect(ColleagueBound.closesCycle({ path: ["aris", "theron"], target: "aris", answering: false, room: ROOM })).toBe(
      false,
    )
  })

  test("🔴 …and without the room it was refused as a cycle — the control", () => {
    // The identical call with no room: this is exactly what the code did before, and why the
    // invitation was a promise the delivery layer broke.
    expect(ColleagueBound.closesCycle({ path: ["aris", "theron"], target: "aris", answering: false })).toBe(true)
  })

  test("every current participant is answerable, not just the asker", () => {
    for (const target of ROOM)
      expect(ColleagueBound.closesCycle({ path: ROOM, target, answering: false, room: ROOM })).toBe(false)
  })

  test("⚠️ someone OUTSIDE the room is still a cycle", () => {
    // The exemption is the room, not a blanket amnesty. A chain that wandered through `pictor` and
    // tries to close on it is still a loop, room or no room.
    expect(
      ColleagueBound.closesCycle({ path: ["aris", "pictor"], target: "pictor", answering: false, room: ROOM }),
    ).toBe(true)
  })

  test("⚠️ an ordinary 1:1 chain is unchanged when there is no room", () => {
    // Absent room must behave exactly as before, or every existing exchange changes meaning.
    expect(ColleagueBound.closesCycle({ path: ["aris", "theron"], target: "theron", answering: false })).toBe(true)
    expect(ColleagueBound.closesCycle({ path: ["aris"], target: "theron", answering: false })).toBe(false)
  })

  test("answering still short-circuits, room or not", () => {
    expect(ColleagueBound.closesCycle({ path: ["aris"], target: "aris", answering: true })).toBe(false)
  })

  test("⚠️ the room exempts the CYCLE rule only — the hop cap is untouched", () => {
    // A room that could loop for ever would be a worse bug than the one this fixes. The budget is a
    // different mechanism and still bites.
    expect(ColleagueBound.exceedsHopCap(ColleagueBound.HOP_CAP + 1)).toBe(true)
  })
})
