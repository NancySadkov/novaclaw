import { describe, expect, test } from "bun:test"
import { MessengerPipeline } from "./pipeline"
import { SPAWN_LIMIT_REASONS } from "../session/spawn-limit-reason"

/**
 * 🔴 **Every quota refusal has a SENTENCE, and that is the only thing standing between a new reason and
 * an operator reading `undefined`.**
 *
 * This function is a lookup keyed on a tagged union, and a lookup's failure mode is a MISS — not an
 * exception, not a type error at the call site, just an absent string handed to a chat. The union was
 * hand-copied here for most of its life, and the copy is what made that possible.
 *
 * So the assertions are structural rather than per-wording: the table is walked from the SPAWNER'S
 * list, which is the same list the error, the worker protocol and the tool's wording all read. A sixth
 * reason fails this file until somebody writes its sentence.
 */
describe("an operator is told why a task did not start", () => {
  test("every reason the spawner can raise has wording here", () => {
    expect(SPAWN_LIMIT_REASONS.length).toBeGreaterThan(0)
    for (const reason of SPAWN_LIMIT_REASONS) {
      const sentence = MessengerPipeline.spawnLimitReply({ reason, depth: 3, limit: 10 })
      expect(sentence, `no operator wording for "${reason}"`).toBeTruthy()
      expect(sentence.trim().length, `"${reason}" produced an empty sentence`).toBeGreaterThan(20)
      // A lookup miss in JS yields undefined, and `undefined` stringifies to the word below.
      expect(sentence, `"${reason}" fell through to a missing entry`).not.toContain("undefined")
    }
  })

  test("a ceiling and a rate quote the bound the operator set", () => {
    // These two are caps somebody chose, so the number is the actionable part: which bound, and by how
    // much it was missed.
    expect(MessengerPipeline.spawnLimitReply({ reason: "children", depth: 3, limit: 10 })).toContain("3")
    expect(MessengerPipeline.spawnLimitReply({ reason: "children", depth: 3, limit: 10 })).toContain("10")
    expect(MessengerPipeline.spawnLimitReply({ reason: "rate", depth: 12, limit: 10 })).toContain("12")
  })

  /**
   * 🔴 **The two refusals that are NOT a cap quote no numbers and ask for no change to what the person
   * did.** A figure here reads as a limit somebody chose, when the truth is the machine's own verdict at
   * this moment (`pressure`) or a standing policy (`disabled`) — and "let some finish, then ask again"
   * is a lie about a policy, because nothing about waiting changes it.
   */
  test("machine pressure and a standing policy quote no bounds, and neither says to wait", () => {
    for (const reason of ["pressure", "disabled"] as const) {
      const sentence = MessengerPipeline.spawnLimitReply({ reason, depth: 0, limit: 0 })
      expect(sentence, `${reason} quoted a number`).not.toMatch(/\b\d+\b/)
      expect(sentence, `${reason} told the operator to wait it out`).not.toMatch(/then ask again/i)
    }
    // Each names the thing that WILL move, because a refusal with no route out is a dead end.
    expect(MessengerPipeline.spawnLimitReply({ reason: "pressure", depth: 0, limit: 0 })).toContain("memory")
    expect(MessengerPipeline.spawnLimitReply({ reason: "disabled", depth: 0, limit: 0 })).toContain("colleagues")
  })
})
