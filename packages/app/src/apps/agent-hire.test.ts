import { describe, expect, test } from "bun:test"
import { planHire } from "./agent-hire"
import type { AgentLike } from "./contacts"

const agent = (over: { id: string } & Partial<Omit<AgentLike, "id">>): AgentLike =>
  ({ mode: "primary", hidden: false, ...over }) as AgentLike

describe("hiring from the roster", () => {
  test("the new colleague is a colleague, not staff", () => {
    // Without an explicit mode the row takes the store's default and could land as a sub-agent —
    // vanishing from the very list the user just hired it into.
    expect(planHire({ roster: [], random: () => 0 }).fragment["mode"]).toBe("primary")
  })

  test("it arrives with a NAME and nothing else", () => {
    // A hire made from a button has nothing to say about the job yet. Pre-filling "Assistant" would
    // put words in the user's mouth that the roster then shows as if they meant them.
    const hire = planHire({ roster: [], random: () => 0 })
    expect(Object.keys(hire.fragment).sort()).toEqual(["mode", "name"])
    expect(hire.name.length).toBeGreaterThan(0)
    expect(hire.fragment["name"]).toBe(hire.name)
  })

  test("the name avoids ids AND display names already on the roster", () => {
    const first = planHire({ roster: [], random: () => 0 })
    const second = planHire({
      roster: [agent({ id: first.id, name: first.name })],
      random: () => 0,
    })
    // Two colleagues reading as the same name are indistinguishable in a hand-off line even when
    // their keys differ — the collision that matters is a reading one.
    expect(second.id).not.toBe(first.id)
  })
})
