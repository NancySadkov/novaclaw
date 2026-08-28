import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { AgentV2 } from "@novaclaw/core/agent"
import { roster } from "@/apps/contacts"

/**
 * THE LAUNCHER OPENS NOVA'S CHAT, AND NEVER A POSTURE'S.
 *
 * Owner, 2026-08-24: *"ensure there are no such ghost officers, and instead the [bar] at the bottom
 * defaults to Nova itself, while the user can only speak with the officers, which are fully
 * responsible for their subagents."*
 *
 * ⚠️ It already landed on Nova before this — but only because `roster()` sorts the governing agent
 * first. A rule satisfied by a SORT ORDER is a rule that moves when someone changes the sort, with
 * nothing to notice, so it is pinned here by NAME.
 */

const source = fs.readFileSync(path.join(import.meta.dir, "new-agent-bar.tsx"), "utf8")

const AGENTS = [
  { id: "wren", name: "Wren", mode: "primary" as const, hidden: false },
  { id: "build", mode: "primary" as const, hidden: false },
  { id: "plan", mode: "primary" as const, hidden: false },
  { id: "nova", name: "Nova", mode: "primary" as const, hidden: false },
  { id: "explore", mode: "subagent" as const, hidden: false },
  { id: "title", mode: "primary" as const, hidden: true },
]

describe("what the launcher opens", () => {
  test("🔴 the default is Nova BY NAME, not by roster position", () => {
    expect(source).toContain("option.id === AgentV2.DEFAULT_COLLEAGUE_ID")
    // The old form, which this replaced. If it comes back the default is a sort order again.
    expect(source).not.toContain("chosenAgent() ?? agentOptions()[0]?.id")
  })

  /**
   * 🔴 **NO OWNERLESS CHAT, EVER** (owner, 2026-08-28: *"Clicking `Start new chat` at home creates a
   * ghost session `New session in scratch` — that shouldn't be possible at all, since can't have
   * sessions without any agents"*).
   *
   * The clause this replaces was deliberate — *"a roster that has SETTLED with nobody in it still
   * falls through, so a degraded instance keeps its escape hatch"* — and it was the one input that
   * could mint a chat belonging to no one: no colleague, so no roster row, so no door back to it. It
   * fired exactly when the instance was already broken.
   *
   * ⚠️ Asserted on the SOURCE because this branch is a click handler inside a component that needs a
   * server, a roster and a sync store to mount. That is a weaker test than exercising it, and it is
   * recorded as such: it catches the guard being deleted, not the guard being wrong.
   */
  test("🔴 a click with no colleague resolved REFUSES instead of spawning", () => {
    // The refusal exists...
    expect(source).toContain("if (id === undefined)")
    expect(source).toContain("home.newAgent.noColleagues")
    // ...and it comes BEFORE the spawn, or it is decoration.
    expect(source.indexOf("if (id === undefined)")).toBeLessThan(source.indexOf("void agent.spawn(id,"))
    // The shape that produced the ghost: spawning with nothing chosen.
    expect(source).not.toContain("agent.spawn(undefined")
  })

  test("🔴 the picker offers officers only — no posture, no sub-agent, no machinery", () => {
    const offered = roster(AGENTS).map((view) => view.id)
    expect(offered).toContain("nova")
    expect(offered).toContain("wren")
    for (const ghost of ["build", "plan", "explore", "title"]) expect(offered).not.toContain(ghost)
  })

  test("Nova is offered first, and is the one the default resolves to", () => {
    const offered = roster(AGENTS).map((view) => view.id)
    expect(offered[0]).toBe(AgentV2.DEFAULT_COLLEAGUE_ID)
  })

  test('🔴 the chat is titled with the colleague\'s NAME, not left as "New session"', () => {
    // Owner, 2026-08-24. Contacts already passed a title; this door did not — and one chat per agent
    // means both doors reach the SAME chat, so whichever opened it first decided the title forever.
    expect(source).toContain("title: agentTitle(agentID)")
    expect(source).toContain("agentOptions().find((option) => option.id === id)?.name")
    // Never titled `undefined`: the id is the fallback when a colleague has no display name.
    expect(source).toContain("agentName?.trim() || id")
  })

  test("⚠️ the fallback is still an OFFICER when Nova is absent", () => {
    // A paused or hidden Nova must leave a working launcher — but not one that reaches for `build`.
    const withoutNova = AGENTS.filter((agent) => agent.id !== "nova")
    const offered = roster(withoutNova).map((view) => view.id)
    expect(offered.length).toBeGreaterThan(0)
    for (const ghost of ["build", "plan"]) expect(offered).not.toContain(ghost)
  })
})
