import { describe, expect, test } from "bun:test"
import { SkillGuidance } from "@novaclaw/core/skill/guidance"

/**
 * ─── the RESIDENT SKILLS INDEX, ratcheted ───────────────────────────────────────────────────────
 *
 * 🔴 `notes/reports/disclosure-tiers-2026-08-12.md`: three disclosure tiers ship and only one of them
 * is bounded. The skills index is tier 2 — every permitted skill's name and description, in EVERY
 * request — and nothing measured it. Tier 1 (resident tool schemas) has both a ratchet and an escape
 * hatch behind `tool_search`; this had neither.
 *
 * ⚠️ Why a per-item ratchet and not a total. The instance's skill COUNT is the user's business — they
 * install what they want — so a ceiling on the whole index would fail on a machine that did nothing
 * wrong. What must not drift is the PER-SKILL constant, because that is ours: it is decided by this
 * renderer's markup, and every byte added to it is multiplied by however many skills a stranger has.
 *
 * ⚠️ The resident tool set sat at 99.4% of its ceiling for days with nothing reporting it. A cost that
 * nobody measures is a cost that grows.
 */

/** A modest, realistic entry: a one-sentence description of a recurring task. */
const entry = (index: number) => ({
  name: `skill-${index}`,
  description: "Guidance for a specific recurring task, with the steps and the files it needs.",
})

const bytes = (count: number) =>
  Buffer.byteLength(SkillGuidance.render(Array.from({ length: count }, (_, index) => entry(index))))

describe("the resident skills index", () => {
  test("the ratchet can see the renderer at all", () => {
    // A ratchet whose subject silently became a no-op passes forever.
    expect(bytes(0)).toBeGreaterThan(50)
    expect(SkillGuidance.render([])).toContain("No skills are currently available.")
    expect(SkillGuidance.render([entry(1)])).toContain("skill-1")
  })

  /**
   * The number this file exists for. 157 B/skill measured 2026-08-12; the ceiling sits just above it
   * so an ordinary wording tweak passes and a structural change to the markup does not.
   *
   * If this goes red, the question is NOT "how do I fit under it" — it is **should this still be
   * resident at all?** Every byte here is paid on every turn of every session, multiplied by the
   * user's skill count, and the escape (a count plus a search, as `tool_search` does) is already
   * proven. Raise it only with that question answered in the commit message.
   */
  const PER_SKILL_BYTES = 170

  test("a skill costs about 157 resident bytes, and the constant does not drift", () => {
    const marginal = (bytes(101) - bytes(1)) / 100
    expect(marginal).toBeLessThan(PER_SKILL_BYTES)
    // Measured with a fixed-width name and one sentence, so it is stable across runs.
    expect(Math.round(marginal)).toBe(157)
  })

  test("the index is LINEAR — no hidden per-item overhead that only shows up at scale", () => {
    // Two independent slopes, far apart. A renderer that grew super-linearly (a join over pairs, an
    // index rebuilt per entry) would pass a single-point check and fail a stranger with 300 skills.
    const low = (bytes(11) - bytes(1)) / 10
    const high = (bytes(501) - bytes(1)) / 500
    expect(Math.abs(high - low)).toBeLessThan(3)
  })

  test("🔴 what tier 2 costs at scale, stated so it cannot be forgotten", () => {
    // Not a bound — a fact. At ~142 skills this index passes the ENTIRE resident tool schema set
    // (22 235 compiled wire bytes, measured live the same day), and that is the moment skills should
    // have moved behind a search.
    expect(bytes(142)).toBeGreaterThan(22_235)
    expect(bytes(100)).toBeLessThan(22_235)
    // …and the 1 000-skill figure the report quotes.
    expect(bytes(1000)).toBeGreaterThan(150_000)
  })
})
