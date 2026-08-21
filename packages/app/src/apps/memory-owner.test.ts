import { describe, expect, test } from "bun:test"
import type { AgentLike } from "./contacts"
import { defaultOwner, ownersFor, scopeLabelKey, scopeOwnerName, SHARED_KEY } from "./memory-owner"

const agent = (over: Partial<AgentLike> & { id: string }): AgentLike => ({ mode: "primary", hidden: false, ...over })

const owners = ownersFor([agent({ id: "trader" }), agent({ id: "nova" }), agent({ id: "general", mode: "subagent" })], "Shared")

describe("whose memory the app can show", () => {
  test("one entry per colleague, then the household — sub-agents are not owners", () => {
    // Staff spawned for one task own nothing: their memories ride their officer's cabinet.
    expect(owners.map((owner) => owner.key)).toEqual(["agent:nova", "agent:trader", SHARED_KEY])
  })

  test("a colleague's page shows ONLY that colleague's cabinet", () => {
    // Not `agent:x` ∪ `global`, even though its turns read both: this view answers "what does Trader
    // know that nobody else does", and folding in the household's facts would make every colleague's
    // page look the same and hide the partition the roster promises.
    expect(owners.find((owner) => owner.key === "agent:trader")!.scopes).toEqual(["agent:trader"])
  })

  test("the household's shared facts are an OWNER, not a checkbox", () => {
    const shared = owners.find((owner) => owner.key === SHARED_KEY)!
    expect(shared).toMatchObject({ kind: "shared", scopes: ["global"], label: "Shared" })
  })

  test("the CEO is the default view, and an empty instance has no default rather than a wrong one", () => {
    expect(defaultOwner(owners)!.key).toBe("agent:nova")
    expect(defaultOwner([])).toBeUndefined()
  })
})

describe("what a scope means, in words", () => {
  test("each of the three scopes reads as who can see it", () => {
    expect(scopeLabelKey("global")).toBe("memory.scope.shared")
    expect(scopeLabelKey("session:ses_1")).toBe("memory.scope.chat")
    expect(scopeLabelKey("agent:trader")).toBe("memory.scope.agent")
  })

  test("a colleague's scope carries the NAME, not the stored key", () => {
    expect(scopeOwnerName("agent:trader", owners)).toBe("Trader")
    // A chat scope belongs to no colleague: claiming otherwise would misstate who can read it.
    expect(scopeOwnerName("session:ses_1", owners)).toBeUndefined()
    expect(scopeOwnerName("global", owners)).toBeUndefined()
  })
})
