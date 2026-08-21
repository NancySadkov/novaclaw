import { describe, expect, test } from "bun:test"
import { AgentWorkspace } from "@novaclaw/core/agent/workspace"
import { Scratch } from "@novaclaw/core/scratch"

// WHERE a colleague works (owner, 2026-08-21: the folder is part of the agent's configuration,
// defaulting to that agent's scratch, and reassigning it messages the agent).

describe("the folder a colleague works on", () => {
  test("its own scratch when nothing is configured — never a shared one", () => {
    // Per agent, because a roster sharing one scratch dir is a filing cabinet with no drawers: the
    // bookkeeper's notes and the dungeon master's land in the same place.
    expect(AgentWorkspace.folderFor({ agentID: "theron", directory: undefined })).toBe(Scratch.forAgent("theron"))
    expect(Scratch.forAgent("theron")).not.toBe(Scratch.forAgent("aris"))
  })

  test("the configured project when there is one", () => {
    expect(AgentWorkspace.folderFor({ agentID: "theron", directory: "D:/books" })).toBe("D:/books")
  })

  test("blank and whitespace are NOT a folder", () => {
    // A cleared text field arrives as "" or " ", and treating either as a working directory would
    // point a colleague at the process's cwd — somewhere nobody chose.
    for (const value of ["", "   "])
      expect(AgentWorkspace.folderFor({ agentID: "theron", directory: value })).toBe(Scratch.forAgent("theron"))
  })
})

describe("whether a reassignment happened at all", () => {
  test("unset → the same colleague's scratch path is NOT a move", () => {
    // A user who picks the scratch folder explicitly has not moved the colleague anywhere, and a
    // message about nothing trains them to ignore the ones that mean something.
    expect(
      AgentWorkspace.moved({ agentID: "theron", from: undefined, to: Scratch.forAgent("theron") }),
    ).toBe(false)
  })

  test("a real change IS a move, in both directions", () => {
    expect(AgentWorkspace.moved({ agentID: "theron", from: undefined, to: "D:/books" })).toBe(true)
    expect(AgentWorkspace.moved({ agentID: "theron", from: "D:/books", to: undefined })).toBe(true)
    expect(AgentWorkspace.moved({ agentID: "theron", from: "D:/books", to: "D:/ledger" })).toBe(true)
  })

  test("the same folder twice is not a move", () => {
    expect(AgentWorkspace.moved({ agentID: "theron", from: "D:/books", to: "D:/books" })).toBe(false)
  })
})

describe("what the colleague is told", () => {
  test("both ends are named — knowing only the destination cannot date a stale plan", () => {
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "D:/ledger", ownScratch: false })
    expect(notice).toContain("D:/books")
    expect(notice).toContain("D:/ledger")
    // The fact, plus permission to carry on — not a task. "You have been moved" alone invites a model
    // to go and do something about it.
    expect(notice).toContain("out of date")
  })

  test("going back to its own workspace reads as that, not as a new project", () => {
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "/scratch/theron", ownScratch: true })
    expect(notice).toContain("your own")
    expect(notice).not.toContain("out of date")
  })
})
