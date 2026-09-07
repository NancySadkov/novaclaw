import fs from "node:fs"
import path from "node:path"
import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { OfficerName } from "@novaclaw/core/agent/officer-name"
import { isColleague } from "@novaclaw/core/agent"

/**
 * THE ROSTER SHIPS WITH COLLEAGUES ON IT — AS CONFIG, SO RETIRE STICKS.
 *
 * Owner, 2026-08-25: *"ensure Nova comes with a few common agents, like one for just chat, one for
 * programming, and another for visual art."*
 *
 * Principle 12(a), *work by default*: an empty roster asks a new user to invent an org chart before
 * they have seen one work — the same failure as a setting with no sane default.
 *
 * 🔴 **They are seeded as CONFIG, not in `plugin/agent.ts`, and the difference is whether RETIRE
 * STICKS.** Code-seeding looked right — "defaults ship in code" — and was wrong: the plugin
 * re-declares its agents every boot, so retiring one removed the config row and the plugin put it
 * straight back. Measured before this moved: `DELETE /api/agent/xenia` answered **204** and Xenia was
 * still on the roster. A control that reports success and changes nothing is the worse half of the
 * bug; a colleague you cannot get rid of is not yours.
 */

const SEEDED = ["xenia", "daedalus", "myron", "researcher"] as const

/** The seed source, read as text: these are config literals, not exported values. */
const SEED_SOURCE = fs.readFileSync(path.join(import.meta.dir, "..", "src", "agent-config-seed.ts"), "utf8")

describe("the colleagues that ship", () => {
  test("🔴 their names come from the SAME pool a hire draws from", () => {
    // Not a separate naming scheme. A seeded roster and a hired one must be the same kind of thing,
    // or the address book reads as two lists — and `planHire`'s taken-set, which reads the roster,
    // would not know to avoid these.
    for (const id of SEEDED.filter((id) => id !== "researcher")) expect(OfficerName.POOL).toContain(id)
    // Researcher is a named product role, retained from the bundled skill the user sees.
    expect(SEEDED).toContain("researcher")
  })

  test("🔴 each is a COLLEAGUE, not machinery", () => {
    // `isColleague` is what Contacts filters on and what `addressable` offers a model. A seeded agent
    // that failed it would ship invisible — the exact ghost this programme spent the week removing.
    for (const id of SEEDED) expect(isColleague({ id, mode: "primary" })).toBe(true)
  })

  test("🔴 none is a BUILT-IN — a plugin agent cannot be retired, and these must be", () => {
    // The permission baseline ledger enumerates the built-in set by name so a new one "cannot join
    // without being looked at". These deliberately do NOT join it: a built-in is re-declared every
    // boot, which is right for machinery and for Nova and wrong for a colleague.
    const plugin = fs.readFileSync(path.join(import.meta.dir, "..", "src", "plugin", "agent.ts"), "utf8")
    for (const id of SEEDED) expect(plugin).not.toContain(`"${id}"`)
    const seed = fs.readFileSync(path.join(import.meta.dir, "..", "src", "agent-config-seed.ts"), "utf8")
    for (const id of SEEDED) expect(seed).toContain(`id: "${id}"`)
  })

  test("⚠️ none of them is PROTECTED — they are the user's to rewrite or retire", () => {
    // Only Nova is fixed.
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

/**
 * THE COMPANION IS A CHAT, NOT AN AGENT (owner, 2026-09-02).
 *
 * Xenia is the colleague a user opens to talk to the MODEL — to see how it answers, with nothing in
 * the way. It shipped as an ordinary officer: `memory: "own"` and the full tool surface, so that turn
 * spent itself recalling a memory graph and reading files before saying anything.
 *
 * The stance it needed already existed. `ConfigAgent.shortChat` is documented as "the fast local Chat
 * stance, no project access or memory", and `ShortChat.permissionRules` hard-denies every action but
 * `upgrade_chat`. The fix was to seed it, not to build a second simple-agent mechanism beside it.
 */
describe("the companion is a chat", () => {
  test("🔴 Xenia ships in the fast chat stance, with no memory", () => {
    const xenia = SEED_SOURCE.slice(SEED_SOURCE.indexOf('id: "xenia"'), SEED_SOURCE.indexOf('id: "daedalus"'))
    expect(xenia).toContain("shortChat: true")
  })

  test("the WORKING colleagues are untouched — this stance is Xenia's alone", () => {
    // The pair. Without it this file would pass on a seed that put every colleague in chat mode,
    // which would take the tools away from the engineer and the artist.
    // Bounded to the officer LITERALS. Slicing to end of file would also catch the decode block's
    // `officer.shortChat` conditional, which is the mechanism rather than a stance — a control that
    // fires on the fix it is controlling for proves nothing.
    const literalsEnd = SEED_SOURCE.indexOf("export const seedFromDirectory")
    const rest = SEED_SOURCE.slice(SEED_SOURCE.indexOf('id: "daedalus"'), literalsEnd)
    expect(literalsEnd).toBeGreaterThan(0)
    expect(rest).not.toContain("shortChat")
  })

  test("a chat stance carries no memory, and an ordinary colleague still does", () => {
    // Read as the conditional the seed actually writes, so a future edit that hardcodes "own" back
    // for everyone fails here rather than at a user's first slow companion turn.
    expect(SEED_SOURCE).toContain('memory: officer.shortChat ? "none" : "own"')
  })

  test("the brief does not instruct a move the permission floor denies", () => {
    // It used to end by offering to hand work to the colleague who owns it. Under this stance the
    // only available move is `upgrade_chat`, and `ShortChat.GUIDANCE` already says so in the words
    // the tool needs — a persona arguing with its own harness is a prompt that cannot be obeyed.
    const xenia = SEED_SOURCE.slice(SEED_SOURCE.indexOf('name: "Xenia"'), SEED_SOURCE.indexOf('id: "daedalus"'))
    expect(xenia).not.toContain("hand it over")
  })
})
