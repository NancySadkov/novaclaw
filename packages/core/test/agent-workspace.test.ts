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
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "D:/ledger", ownScratch: false, rooted: "D:/books" })
    expect(notice).toContain("D:/books")
    expect(notice).toContain("D:/ledger")
  })

  // 🔴 THE NOTICE MUST NOT CLAIM THE CHAT MOVED, because it does not. Measured 2026-08-22: a
  // colleague reassigned folderA → folderB was told "you now work on folderB" while its session's
  // `location.directory` stayed folderA, so every tool call would still land in the old folder while
  // it believed otherwise. Repointing a live session across PROJECTS is refused outright by
  // `control-plane/move-session.ts`, so the honest sentence is the one that survives.
  test("it says THIS conversation has not moved, and how to start one that has", () => {
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "D:/ledger", ownScratch: false, rooted: "D:/books" })
    expect(notice).toContain("still rooted in D:/books")
    expect(notice).toContain("cannot work on D:/ledger in this chat")
    expect(notice.toLowerCase()).toContain("clear this chat")
  })

  test("it warns off the search that would otherwise happen", () => {
    // Without this a model reassigned to a project it cannot reach lists the OLD folder, finds none
    // of the new project's files, and reports the new project as empty or broken.
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "D:/ledger", ownScratch: false, rooted: "D:/books" })
    expect(notice).toContain("will not find them")
  })

  // 🔴 THE SECOND REASSIGNMENT, where `from` and the chat's real root diverge. The chat stays where
  // it was CREATED; `from` is only the config's previous value. Naming `from` as the root was the
  // same false statement this notice exists to remove, one level deeper — caught live on the second
  // move, not the first.
  test("the root is the CHAT's, not the config's previous value", () => {
    const notice = AgentWorkspace.reassignmentNotice({
      from: "D:/ledger",
      to: "D:/books",
      ownScratch: false,
      rooted: "D:/original",
    })
    expect(notice).toContain("still rooted in D:/original")
    expect(notice).not.toContain("still rooted in D:/ledger")
  })

  test("going back to its own workspace reads as that, not as a new project", () => {
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "/scratch/theron", ownScratch: true, rooted: "D:/books" })
    expect(notice).toContain("your own")
    // …and carries the same caveat, because the chat does not follow it home either.
    expect(notice).toContain("still rooted in D:/books")
  })
})
