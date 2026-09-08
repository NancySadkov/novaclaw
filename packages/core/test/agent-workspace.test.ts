import { describe, expect, test } from "bun:test"
import { AgentWorkspace } from "@novaclaw/core/agent/workspace"
import { Scratch } from "@novaclaw/core/scratch"
import type { SessionMessage } from "@novaclaw/core/session/message"
import { isSteerText } from "@novaclaw/core/session/steer-provenance"

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
    expect(AgentWorkspace.moved({ agentID: "theron", from: undefined, to: Scratch.forAgent("theron") })).toBe(false)
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

describe("whether a transcript has model output", () => {
  const message = (value: unknown) => value as SessionMessage.Message

  test("a new chat, a user-only chat, and an empty assistant turn are not output", () => {
    expect(AgentWorkspace.hasModelOutput([])).toBe(false)
    expect(AgentWorkspace.hasModelOutput([message({ type: "user", text: "hello" })])).toBe(false)
    expect(
      AgentWorkspace.hasModelOutput([message({ type: "assistant", content: [{ type: "text", text: "" }] })]),
    ).toBe(false)
  })

  test("text, reasoning, and an actual tool call count as model output", () => {
    for (const content of [
      [{ type: "text", text: "done" }],
      [{ type: "reasoning", text: "checking" }],
      [{ type: "tool", state: { status: "pending", input: '{"path":"a"}' } }],
      [{ type: "tool", state: { status: "completed", input: {} } }],
    ])
      expect(AgentWorkspace.hasModelOutput([message({ type: "assistant", content })])).toBe(true)
  })

  test("a compaction is evidence that earlier model output existed", () => {
    expect(AgentWorkspace.hasModelOutput([message({ type: "compaction", summary: "answer", recent: "" })])).toBe(true)
  })
})

describe("what the colleague is told", () => {
  const move = { from: "D:/books", to: "D:/ledger", ownScratch: false }

  test("both ends are named — knowing only the destination cannot date a stale plan", () => {
    const notice = AgentWorkspace.reassignmentNotice(move)
    expect(notice).toContain("D:/books")
    expect(notice).toContain("D:/ledger")
    expect(isSteerText(notice), "the renderer can fold this automated nudge").toBe(true)
  })

  /**
   * 🔴 **The notice REPORTS; it no longer instructs, because there is nothing left to instruct.**
   *
   * History, kept so the stranded-chat design is not reintroduced by someone reading only the code:
   * a colleague reassigned folderA → folderB used to be told "you now work on folderB" while its
   * session's `location.directory` stayed folderA — every tool call would land in the old folder
   * while it believed otherwise. `control-plane/move-session.ts` refuses a cross-project move
   * outright, so the chat genuinely could not follow, and the honest notice admitted the chat was
   * stranded and asked the USER to clear it.
   *
   * That was honesty as a workaround. Reassignment now ARCHIVES the old chat and opens its successor
   * in the new folder (`agent/reassignment.ts`), so the sentence that survives is the one describing
   * what already happened. The old assertions — "still rooted in", "cannot work on … in this chat",
   * "clear this chat" — are asserted ABSENT below, because their return would mean the stranding did.
   */
  test("it says the old conversation was filed and this one starts in the new folder", () => {
    const notice = AgentWorkspace.reassignmentNotice(move)
    expect(notice).toContain("filed")
    expect(notice).toContain("starts")
    expect(notice).toContain("D:/ledger")
  })

  test("it does NOT strand the chat, nor hand the user homework", () => {
    const notice = AgentWorkspace.reassignmentNotice(move).toLowerCase()
    for (const stranded of ["still rooted in", "cannot work on", "clear this chat", "will not find them"])
      expect(notice).not.toContain(stranded)
  })

  test("the own-scratch return is reported the same way", () => {
    const notice = AgentWorkspace.reassignmentNotice({ from: "D:/books", to: "D:/scratch/wren", ownScratch: true })
    expect(notice).toContain("your own")
    expect(notice).toContain("filed")
    expect(notice.toLowerCase()).not.toContain("clear this chat")
  })
})
