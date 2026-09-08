import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `disabled: true` PAUSES a colleague; it does not remove one.
 *
 * 🔴 It used to be `draft.remove(agentID)` — a fourth removal door bypassing every guarantee of
 * `agent/retire.ts` (`AgentUsage.forget`, `archiveChats`, `agent:<id>` → `retired:<id>:<at>`),
 * reachable from an ordinary config write and unconfirmed. It cannot ever have been a retirement:
 * retirement is CONFIRM-GATED by its own definition and a config write carries no confirmation.
 *
 * Three things removal broke, and each is a case below:
 *   1. the chat was left LIVE but DOORLESS — the roster row is the only way into a colleague's chat;
 *   2. the id left the roster, so `planHire`'s `taken` set no longer held it and `OfficerName.pick`
 *      could redraw it, handing the NEXT colleague the paused one's cabinet at `agent:<id>`;
 *   3. usage kept accruing to a name nobody could see.
 *
 * ⚠️ And the half that must NOT change: a paused colleague still may not act. That verdict is
 * `missingAgentPermissions` — deny `*` on `*` — the same ruleset a removed agent already produced
 * via `agents.resolve` returning undefined. Pausing is only safe if both arms agree, so this file
 * pins that they are the SAME constant rather than two deny-alls that could drift apart.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.resolve(here, "../src", rel), "utf8")
/** ⚠️ Comments stripped — this file's own header quotes the line it asserts is gone. */
const code = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")

describe("disabled pauses, it does not remove", () => {
  const plugin = code(read("config/plugin/agent.ts"))
  const permission = code(read("permission.ts"))
  const agent = code(read("agent.ts"))

  test("the config door MARKS the agent instead of removing it", () => {
    // ⚠️ Matched on `paused` + an assignment, not on one spelling. The first version of this asserted
    // the literal `"paused: true"` and went red when the fix itself changed the object-spread form to
    // a mutator (`Draft.update` ignores a returned value) — a ledger pinning SYNTAX fails on a
    // correct edit, which trains people to loosen it rather than read it.
    expect(plugin).toMatch(/paused\s*[:=]\s*true/)
    // The exact call that caused the damage. Named, so a revert is loud.
    expect(plugin).not.toContain("draft.remove(agentID)")
  })

  test("a paused colleague is denied through the SAME ruleset as a missing one", () => {
    // Not "a deny-all exists" — the same named constant, so the two arms cannot drift.
    expect(permission).toContain("agent?.paused === true) return missingAgentPermissions")
    expect(permission).toContain("agent?.permissions ?? missingAgentPermissions")
  })

  test("a paused colleague is never the instance's fallback agent", () => {
    expect(agent).toContain("agent.paused !== true")
  })

  test("but it is STILL A COLLEAGUE — it stays on the roster, which is what holds its id", () => {
    // 🔴 The clause that closes the cabinet leak. `isColleague` must NOT exclude paused: the roster
    // is what `planHire` builds `taken` from, so an agent off the roster is an id free to be redrawn.
    // ⚠️ Sliced to the EXPRESSION, not to end-of-file: a slice that ran on caught `selectable`
    // twenty lines later — which legitimately excludes paused — and failed for the wrong reason.
    const from = agent.indexOf("export const isColleague")
    const isColleague = agent.slice(from, agent.indexOf("export const", from + 10))
    expect(isColleague).toContain("POSTURE_IDS")
    expect(isColleague).not.toContain("paused")
  })
})
