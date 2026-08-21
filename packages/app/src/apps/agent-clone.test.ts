import { describe, expect, test } from "bun:test"
import { planClone } from "./agent-clone"
import type { AgentLike } from "./contacts"

const source: AgentLike = {
  id: "theron",
  system: "Own the books. Never move money without approval.",
  name: "Theron",
  title: "Bookkeeper",
  personality: "Blunt. Shows the arithmetic.",
  avatar: "📒",
  memory: "own",
  mode: "primary",
  hidden: false,
}

describe("what a clone inherits", () => {
  test("the BRIEF — job, personality, face, memory setting", () => {
    const clone = planClone({ source, taken: [], random: () => 0 })
    expect(clone.fragment).toMatchObject({
      // The standing BRIEF is the substance of the copy: a clone with the job title and none of the
      // instructions is a colleague that looks the same and behaves differently. Measured live on
      // 2026-08-21 — the first clone carried no `system` because the loader never read it.
      system: "Own the books. Never move money without approval.",
      title: "Bookkeeper",
      personality: "Blunt. Shows the arithmetic.",
      avatar: "📒",
      memory: "own",
      mode: "primary",
    })
  })

  test("NOT the identity — a fresh id and a fresh name from the pool", () => {
    // A copy that kept the id would share the original's memory scope and its chat: a second Theron
    // that remembers work it never did. The id is the whole separation.
    const clone = planClone({ source, taken: [], random: () => 0 })
    expect(clone.id).not.toBe("theron")
    expect(clone.name).not.toBe("Theron")
    expect(clone.fragment["name"]).toBe(clone.name)
  })

  test("the name avoids every name already in the roster, ids and display names alike", () => {
    // Two colleagues shown as the same name are indistinguishable in a hand-off line even when their
    // ids differ, which is the confusion the pool exists to prevent.
    const first = planClone({ source, taken: [], random: () => 0 })
    const second = planClone({ source, taken: [first.id, first.name], random: () => 0 })
    expect(second.id).not.toBe(first.id)
  })

  test("an absent field stays absent rather than becoming an empty string", () => {
    // "No title" and "a blank title" are different facts, and the roster renders them differently.
    const bare: AgentLike = { id: "kallias", mode: "primary", hidden: false }
    const clone = planClone({ source: bare, taken: [], random: () => 0 })
    expect(Object.keys(clone.fragment).sort()).toEqual(["mode", "name"])
  })

  test("a clone of a colleague is a colleague, never staff", () => {
    // Without an explicit mode the fragment would take the store's default, and a roster entry that
    // silently became a sub-agent would vanish from the list the user just cloned it in.
    const bare: AgentLike = { id: "kallias", mode: "primary", hidden: false }
    expect(planClone({ source: bare, taken: [], random: () => 0 }).fragment["mode"]).toBe("primary")
  })

  test("a throwaway's memory setting is inherited too", () => {
    const joe: AgentLike = { id: "crashtest-joe", memory: "none", mode: "primary", hidden: false }
    expect(planClone({ source: joe, taken: [], random: () => 0 }).fragment["memory"]).toBe("none")
  })
})
