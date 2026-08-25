import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { isColleague } from "@novaclaw/core/agent"

/**
 * THE ROSTER SHIPS WITH COLLEAGUES ON IT.
 *
 * Owner, 2026-08-25: *"ensure Nova comes with a few common agents, like one for just chat, one for
 * programming, and another for visual art."*
 *
 * Principle 12(a), *work by default*: an empty roster asks a new user to invent an org chart before
 * they have seen one work — the same failure as a setting with no sane default. A person opening
 * Contacts should find somebody to talk to, and learn what an officer IS by reading three of them.
 */

const SEEDED = ["xenia", "daedalus", "myron"] as const

describe("the colleagues that ship", () => {
  test("🔴 their names come from the SAME pool a hire draws from", () => {
    // Not a separate naming scheme. A seeded roster and a hired one must be the same kind of thing,
    // or the address book reads as two lists — and `planHire`'s taken-set, which reads the roster,
    // would not know to avoid these.
    for (const id of SEEDED) expect(OfficerName.POOL).toContain(id)
  })

  test("🔴 each is a COLLEAGUE, not machinery", () => {
    // `isColleague` is what Contacts filters on and what `addressable` offers a model. A seeded agent
    // that failed it would ship invisible — the exact ghost this programme spent the week removing.
    for (const id of SEEDED) expect(isColleague({ id, mode: "primary" })).toBe(true)
  })

  test("⚠️ none of them is PROTECTED — they are the user's to rewrite or retire", () => {
    // Defaults ship in code; a store override always wins. Only Nova is fixed.
    for (const id of SEEDED) expect(AgentV2.isProtected(id)).toBe(false)
    expect(AgentV2.isProtected(AgentV2.NOVA_ID)).toBe(true)
  })

  test("⚠️ none collides with a posture, a sub-agent or the governing id", () => {
    // A seeded name landing on `build`, `explore` or `nova` would either be swallowed by machinery or
    // silently rewrite the CEO.
    for (const id of SEEDED) {
      expect(AgentV2.POSTURE_IDS.has(id)).toBe(false)
      expect(id).not.toBe(AgentV2.NOVA_ID)
      expect(["general", "explore", "compaction", "title", "summary"]).not.toContain(id)
    }
  })

  test("they are distinct — three colleagues, not one name three times", () => {
    expect(new Set(SEEDED).size).toBe(SEEDED.length)
  })
})
