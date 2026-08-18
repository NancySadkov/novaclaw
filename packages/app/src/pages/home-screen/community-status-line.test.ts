import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dict as en } from "@/i18n/en"

/**
 * 🔴 **The always-on status line must claim only what it knows.**
 *
 * `CommunityTransport.state()` counts DISTINCT PEERS WHOSE ADDRESS WE HOLD, gathered from contacts
 * and peer exchange. Nothing is dialled to produce that number, and nothing about this transport is a
 * connection: it dials OUT when it has something to send.
 *
 * ⚠️ So "Connected · 5 peers" told a user they were reaching five instances when what was true is
 * that five are worth trying. If all five were off, the line still said Connected. The comment beside
 * the count already holds this surface to the standard — *"the sort of small lie this UI is not
 * allowed to tell"* — while the word next to it was making a bigger claim than the number behind it.
 *
 * ⚠️ Verifying it properly would mean dialling every peer on each render, which is a real cost for a
 * line that is always on screen. Saying what is actually known costs nothing, which is why this is a
 * wording rule rather than a behaviour one.
 */

const source = readFileSync(new URL("./community-network.tsx", import.meta.url), "utf8")

/**
 * The status line's copy, read from the DICTIONARY now that the panel is translatable.
 *
 * ⚠️ It used to be scraped from the TSX, which matches nothing once the strings are `t()` keys — and
 * a ledger that quietly stops matching is worse than none. The dictionary is also the more honest
 * source: it is what an English reader sees, and every other locale falls back to it key by key.
 *
 * ⚠️ The keys are gathered by PREFIX rather than named one by one, so a status string added later is
 * covered without anybody remembering to add it here.
 */
const copy = Object.entries(en)
  .filter(([key]) => key.startsWith("community."))
  .map(([, value]) => value)
  .join(String.fromCharCode(10))

describe("the status line", () => {
  test("🔴 says peers are KNOWN, not connected", () => {
    /**
     * ⚠️ Asserted in the pieces the SOURCE actually contains. The line is a template literal, so
     * "peers known" is never contiguous — it reads `${...} known`, and the first version of this
     * test failed on its own wording rather than on the code.
     */
    expect(copy.length, "the community keys must exist, or every assertion here is vacuous").toBeGreaterThan(1000)
    expect(copy).toContain("Ready —")
    expect(copy, "the count is qualified as KNOWN, not as reached").toContain("peers known")
    /**
     * The specific claim that was wrong. A future edit reaching for the shorter word puts the lie
     * back, and this is the only thing standing between that and a user who believes it.
     */
    expect(copy, "nothing here is a connection — the transport dials out").not.toContain("Connected ·")
  })

  test("⚠️ the three not-online states stay distinguishable", () => {
    /**
     * They are three different situations for the person reading them: one they chose (airgap), one
     * they have not accepted yet (never joined), and one they can fix in a minute (nobody to dial).
     * Collapsing any two would send somebody to look for a switch that is already off.
     */
    expect(copy).toContain("Offline mode is on")
    expect(copy).toContain("add someone with an address")
    expect(copy).toContain("Checking…")
  })

  test("⚠️ and the control: this reads the RENDERED copy, not the comments", () => {
    // Every assertion above would pass against the explanatory comments beside the markup, which is
    // the standing failure mode of a source-scanning test.
    expect(source, "the fixture must contain comments to strip").toContain("/*")
    // The dictionary carries no commentary at all, which is the stronger version of the same rule.
    expect(copy).not.toContain("the sort of small lie this UI is not allowed to tell")
  })
})
