import { describe, expect, test } from "bun:test"
import {
  displayName,
  hiddenRoster,
  isColleague,
  memoryDisclosure,
  roster,
  searchRoster,
  type AgentLike,
} from "./contacts"

const agent = (over: Partial<AgentLike> & { id: string }): AgentLike => ({
  mode: "primary",
  hidden: false,
  ...over,
})

describe("who appears in the roster", () => {
  test("sub-agents and hidden machinery are NOT colleagues", () => {
    // The nameless staff an officer spawns, and the internal agents (compaction/title/summary), are
    // not people you can call. Listing them would be the session list again in different words.
    expect(isColleague(agent({ id: "general", mode: "subagent" }))).toBe(false)
    expect(isColleague(agent({ id: "compaction", hidden: true }))).toBe(false)
    expect(isColleague(agent({ id: "nova" }))).toBe(true)
    expect(isColleague(agent({ id: "trader", mode: "all" }))).toBe(true)
  })

  test("the roster drops them, so a kernel full of agents is still a short address book", () => {
    const views = roster([
      agent({ id: "trader" }),
      agent({ id: "general", mode: "subagent" }),
      agent({ id: "title", hidden: true }),
      agent({ id: "nova" }),
    ])
    expect(views.map((view) => view.id)).toEqual(["nova", "trader"])
  })
})

describe("order and standing", () => {
  test("the CEO is first, then colleagues by name", () => {
    const views = roster([agent({ id: "zoe" }), agent({ id: "trader" }), agent({ id: "nova" }), agent({ id: "alice" })])
    expect(views.map((view) => view.id)).toEqual(["nova", "alice", "trader", "zoe"])
  })

  test("the governing agent is marked, and offers no Retire control", () => {
    const [nova, trader] = roster([agent({ id: "nova" }), agent({ id: "trader" })])
    expect(nova).toMatchObject({ kind: "governing", removable: false })
    // The floor is under ONE identity — every other colleague stays removable, or the roster is a
    // frozen org chart rather than the user's own organization.
    expect(trader).toMatchObject({ kind: "officer", removable: true })
  })
})

describe("names", () => {
  test("a stored name wins over the id — that is what renaming means", () => {
    // Nova hires "theron"; the user later renames it "Bookkeeper". The id (and therefore the memory
    // scope) must not move, so the row shows the new name over the unchanged key.
    const [view] = roster([agent({ id: "theron", name: "Bookkeeper" })])
    expect(view).toMatchObject({ id: "theron", name: "Bookkeeper" })
  })

  test("a blank stored name falls back rather than rendering an empty row", () => {
    expect(roster([agent({ id: "theron", name: "   " })])[0]!.name).toBe("Theron")
  })
})

describe("a slug is not a name", () => {
  test("ids become readable names on the row", () => {
    expect(displayName("talent-scout")).toBe("Talent Scout")
    expect(displayName("crashtest_joe")).toBe("Crashtest Joe")
    expect(displayName("nova")).toBe("Nova")
  })

  test("a degenerate id still renders as something", () => {
    // Never an empty row: a blank name is indistinguishable from a broken list.
    expect(displayName("-")).toBe("-")
    expect(displayName("")).toBe("")
  })

  test("the job title is the line under the name, and blank is absent rather than empty", () => {
    const [view] = roster([agent({ id: "scout", title: "  Talent Scout  " })])
    expect(view).toMatchObject({ name: "Scout", title: "Talent Scout" })
    expect(roster([agent({ id: "scout", title: "   " })])[0]!.title).toBeUndefined()
  })
})

describe("memory disclosure", () => {
  test("defaults to its own cabinet when the profile says nothing", () => {
    expect(roster([agent({ id: "trader" })])[0]!.memory).toBe("own")
  })

  test("a throwaway colleague is shown as remembering nothing", () => {
    expect(roster([agent({ id: "crashtest-joe", memory: "none" })])[0]!.memory).toBe("none")
  })

  test("BOTH halves are always disclosed — what is private AND what is shared", () => {
    // The competitor's roster names only the private half and shares the machine underneath. A row
    // that says "its own memory" without saying what every colleague still sees is the same lie.
    for (const memory of ["own", "none"] as const) {
      const disclosure = memoryDisclosure(memory)
      expect(disclosure.sharedKey).toBe("contacts.memory.shared")
      expect(disclosure.privateKey).toBe(memory === "none" ? "contacts.memory.none" : "contacts.memory.own")
    }
  })
})

describe("search", () => {
  const views = roster([
    agent({ id: "nova", title: "Chief Executive" }),
    agent({ id: "talent-scout", title: "Recruiting" }),
    agent({ id: "trader", title: "Markets" }),
  ])

  test("finds a colleague by name, by job title, or by id", () => {
    expect(searchRoster(views, "talent").map((view) => view.id)).toEqual(["talent-scout"])
    expect(searchRoster(views, "recruit").map((view) => view.id)).toEqual(["talent-scout"])
    expect(searchRoster(views, "TRADER").map((view) => view.id)).toEqual(["trader"])
  })

  test("an empty query is not a filter", () => {
    expect(searchRoster(views, "   ")).toHaveLength(3)
  })

  test("no match returns nothing rather than everything", () => {
    // A filter that silently falls back to the full list tells the user the thing they searched for
    // exists somewhere in what they are looking at.
    expect(searchRoster(views, "zzz")).toHaveLength(0)
  })
})

// A POSTURE IS NOT A PERSON (owner, 2026-08-22).
//
// 🔴 `build` and `plan` are what `permissionMode` means, not colleagues — and they were listed beside
// Nova in Contacts, offered their own filing cabinets in the Memory app, and selectable as the
// responsible agent for a scheduled task. The roster is the metaphor's own promise that the list is
// people; a setting wearing a name breaks it.
describe("postures are not colleagues", () => {
  test("build and plan are off the roster", () => {
    const ids = roster([agent({ id: "nova" }), agent({ id: "build" }), agent({ id: "plan" }), agent({ id: "theron" })]).map((v) => v.id)
    expect(ids).not.toContain("build")
    expect(ids).not.toContain("plan")
  })

  test("…and everyone else is still on it", () => {
    // The exclusion is by id and must not catch a colleague who happens to be named similarly.
    const ids = roster([agent({ id: "nova" }), agent({ id: "theron" }), agent({ id: "builder" }), agent({ id: "planner" })]).map((v) => v.id)
    expect(ids.sort()).toEqual(["builder", "nova", "planner", "theron"])
  })
})

describe("a paused colleague", () => {
  /**
   * 🔴 Pausing exists so a colleague can be set aside WITHOUT the damage removal did — its chat left
   * live but doorless, its id freed for `OfficerName.pick` to redraw, its cabinet inheritable. The
   * roster row is the door. So the one thing the view must never do is drop it.
   */
  test("is still on the roster, in its usual place, and marked", () => {
    const rows = roster([
      agent({ id: "nova", name: "Nova" }),
      agent({ id: "aris", name: "Aris" }),
      agent({ id: "theron", name: "Theron", paused: true }),
    ])
    expect(rows.map((r) => r.id)).toEqual(["nova", "aris", "theron"])
    expect(rows.find((r) => r.id === "theron")?.paused).toBe(true)
    expect(rows.find((r) => r.id === "aris")?.paused).toBe(false)
  })

  test("pausing does not change where it sorts", () => {
    const order = (paused: boolean) =>
      roster([
        agent({ id: "nova", name: "Nova" }),
        agent({ id: "aris", name: "Aris", paused }),
        agent({ id: "theron", name: "Theron" }),
      ]).map((r) => r.id)
    // Sorting a paused colleague away would recreate the invisibility pausing was built to avoid.
    expect(order(true)).toEqual(order(false))
  })

  test("it is still searchable — you have to find it to un-pause it", () => {
    const rows = roster([agent({ id: "theron", name: "Theron", paused: true })])
    expect(searchRoster(rows, "ther").map((r) => r.id)).toEqual(["theron"])
  })
})

describe("hidden colleagues have a door", () => {
  /**
   * 🔴 `hidden` removes a row from `roster()` while the colleague stays able to act — unlike pausing,
   * which denies it everything. The row is the only way into a colleague's chat, so hiding one made
   * a doorless chat with a RUNNING agent. `hiddenRoster` is that door.
   */
  test("a hidden colleague is out of the main roster and in the hidden one", () => {
    const rows = [agent({ id: "aris", name: "Aris" }), agent({ id: "theron", name: "Theron", hidden: true })]
    expect(roster(rows).map((r) => r.id)).toEqual(["aris"])
    expect(hiddenRoster(rows).map((r) => r.id)).toEqual(["theron"])
  })

  test("MACHINERY never appears there — it is a 'you hid these' list, not an internals dump", () => {
    // `plugin/agent.ts` sets `hidden` on compaction/title/etc. Those are not colleagues anybody hid.
    const rows = [
      agent({ id: "compaction", name: "compaction", hidden: true, mode: "subagent" }),
      agent({ id: "build", name: "build", hidden: true }),
      agent({ id: "theron", name: "Theron", hidden: true }),
    ]
    expect(hiddenRoster(rows).map((r) => r.id)).toEqual(["theron"])
  })

  test("the two lists never overlap, whatever the flags", () => {
    const rows = [
      agent({ id: "aris", name: "Aris" }),
      agent({ id: "theron", name: "Theron", hidden: true }),
      agent({ id: "spectre", name: "Spectre", paused: true }),
      agent({ id: "vale", name: "Vale", hidden: true, paused: true }),
    ]
    const main = roster(rows).map((r) => r.id)
    const tucked = hiddenRoster(rows).map((r) => r.id)
    expect(main.filter((id) => tucked.includes(id))).toEqual([])
    // A colleague that is BOTH hidden and paused belongs in the hidden list, still marked paused.
    expect(tucked).toContain("vale")
    expect(hiddenRoster(rows).find((r) => r.id === "vale")?.paused).toBe(true)
  })
})
