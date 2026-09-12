import { describe, expect, test } from "bun:test"
import type { AgentLike } from "./contacts"
import {
  agentConfigureRoute,
  agentIDFromOwnerKey,
  defaultOwner,
  ownerFromKey,
  ownerRoute,
  ownersFor,
  scopeLabelKey,
  scopeOwnerName,
  SHARED_KEY,
} from "./memory-owner"

const agent = (over: Partial<AgentLike> & { id: string }): AgentLike => ({ mode: "primary", hidden: false, ...over })

const owners = ownersFor(
  [agent({ id: "trader" }), agent({ id: "nova" }), agent({ id: "general", mode: "subagent" })],
  "Shared",
)

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

// The link a colleague's own config opens. Under the roster, "what does this colleague remember" is a
// question about a COLLEAGUE, so it is asked from that colleague — not by opening a global app and
// hunting for the name in a picker, which is the shape of the chat list the roster replaced.
describe("opening ONE colleague's cabinet by link", () => {
  test("an explicit colleague wins", () => {
    expect(ownerFromKey(owners, "agent:trader")?.scopes).toEqual(["agent:trader"])
    expect(ownerFromKey(owners, SHARED_KEY)?.scopes).toEqual(["global"])
  })

  test("an explicit agent key remains authoritative while the roster is late or missing", () => {
    // The route already chose the cabinet. Roster data supplies the pretty name only; making it a
    // prerequisite for the scope is how a transient roster failure turned remembered data into an
    // empty screen.
    expect(ownerFromKey([], "agent:trader")).toEqual({
      key: "agent:trader",
      label: "Trader",
      scopes: ["agent:trader"],
      kind: "agent",
    })
    expect(ownerFromKey(owners, "agent:retired_last_week")?.key).toBe("agent:retired_last_week")
    expect(ownerFromKey(owners, undefined)?.key).toBe("agent:nova")
    expect(ownerFromKey(owners, "not-an-owner")).toBeUndefined()
  })

  test("the route the dialog writes is the key the page reads", () => {
    const route = ownerRoute("trader")
    const key = new URLSearchParams(route.slice(route.indexOf("?"))).get("owner")
    expect(ownerFromKey(owners, key ?? undefined)?.label).toBe("Trader")
  })

  test("Back has one addressable route to this colleague's configuration", () => {
    expect(agentIDFromOwnerKey("agent:trader")).toBe("trader")
    expect(agentIDFromOwnerKey("global")).toBeUndefined()
    expect(agentConfigureRoute("talent scout")).toBe("/contacts?configure=talent%20scout")
  })
})

// 🔴 A POSTURE HAS NO FILING CABINET (owner, 2026-08-22: *"Build and Plan are the permission
// modes"*). `ownersFor` maps the roster, so this follows from the one exclusion in `contacts.ts` —
// asserted here because this is the surface where a stray owner reads worst: a private memory scope
// belonging to a setting, sitting beside Nova's.
describe("postures own no memories", () => {
  test("build and plan get no owner entry", () => {
    const keys = ownersFor(
      [
        { id: "nova", mode: "primary" },
        { id: "build", mode: "primary" },
        { id: "plan", mode: "primary" },
      ] as never,
      "Shared",
    ).map((owner) => owner.key)
    expect(keys).toEqual(["agent:nova", "global"])
  })
})
