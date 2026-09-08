import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { CommunityObservation } from "@novaclaw/core/community/observation"

/**
 * 🔴 **§5(j) of `notes/spec/honesty-ledger.md`: truthfulness, not generosity.**
 *
 * *"A peer who answers nothing for a month. ✗ Fails if their standing dropped for silence alone."*
 *
 * The policy that turns observations into standing is deliberately absent, so (j) cannot be checked
 * by running it. What CAN be checked is whether the record makes the distinction (j) needs: a peer
 * that declined, ran out of budget, or was switched off has told us nothing about its honesty, and a
 * flat column of strings with no marker is how that comes to be read as a failure later.
 *
 * ⚠️ This file asserts about the VOCABULARY, not about weights. Assigning weight here would be the
 * premature settling the spec warns against; leaving the strings unnamed would be the trap it
 * describes.
 */

const sync = readFileSync(new URL("../src/community/sync.ts", import.meta.url), "utf8")
const handler = readFileSync(
  new URL("../../novaclaw/src/server/routes/instance/httpapi/handlers/community.ts", import.meta.url),
  "utf8",
)

describe("the outcomes CODE writes are named, not spelled", () => {
  test("🔴 every mechanical write site uses the vocabulary", () => {
    /**
     * The failure this prevents is mundane and permanent: one call site writing `no-reply` while
     * another writes `no-answer`, in a column something will later count. An earlier draft of the
     * asking path did exactly that before the constants existed.
     */
    for (const source of [sync, handler]) {
      const literals = [...source.matchAll(/(?:outcome:|dealing\()\s*"([a-z-]+)"/g)].map((match) => match[1])
      expect(literals, "a mechanical outcome must come from CommunityObservation.Outcome").toEqual([])
    }
    expect(sync).toContain("CommunityObservation.Outcome.")
    expect(handler).toContain("CommunityObservation.Outcome.ANSWERED")
  })

  test("⚠️ and the control: the scan can SEE a bare literal", () => {
    // Otherwise the assertion above passes against a regex that matches nothing at all.
    const planted = 'yield* dealing("no-reply")'
    expect([...planted.matchAll(/(?:outcome:|dealing\()\s*"([a-z-]+)"/g)].map((m) => m[1])).toEqual(["no-reply"])
  })
})

describe("silence is distinguishable from a broken promise", () => {
  test("🔴 declining and not replying are SILENCE — §5(j)", () => {
    expect(CommunityObservation.SILENCE.has(CommunityObservation.Outcome.REFUSED)).toBe(true)
    expect(CommunityObservation.SILENCE.has(CommunityObservation.Outcome.NO_ANSWER)).toBe(true)
  })

  test("🔴 an answer that cannot be attributed is NOT silence", () => {
    /**
     * The distinction that makes the set useful. A peer that says nothing is unavailable; a peer that
     * sends something claiming to be an answer, which cannot be attributed to it, has done something
     * — and a policy is entitled to notice the difference. Folding them together would make the set
     * mean "everything that is not a good answer", which is the reading (j) forbids.
     */
    expect(CommunityObservation.SILENCE.has(CommunityObservation.Outcome.UNSIGNED)).toBe(false)
    expect(CommunityObservation.SILENCE.has(CommunityObservation.Outcome.MISATTRIBUTED)).toBe(false)
    expect(CommunityObservation.SILENCE.has(CommunityObservation.Outcome.ANSWERED)).toBe(false)
  })

  test("⚠️ every mechanical outcome is classified, so a new one cannot default to 'not silence'", () => {
    /**
     * A new outcome added later is exactly the case this ledger exists for: it lands here, where
     * somebody has to say which kind it is, rather than inheriting a meaning by omission.
     */
    const every = Object.values(CommunityObservation.Outcome)
    expect(every.sort()).toEqual(["answered", "answered-by-another", "no-answer", "refused", "unsigned-answer"])
    for (const outcome of every) expect(typeof CommunityObservation.SILENCE.has(outcome)).toBe("boolean")
  })
})
