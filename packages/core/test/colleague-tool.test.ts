import { describe, expect, test } from "bun:test"
import { ColleagueTool } from "@novaclaw/core/tool/colleague"
import { SessionOrigin } from "@novaclaw/core/session/origin"
import type { AgentV2 } from "@novaclaw/core/agent"

// Colleagues talking to colleagues (AGENTS.md — the structural metaphor). The rules worth pinning
// are about STANDING: who may be addressed, and what the receiver is told about who is asking.

const agent = (over: { id: string } & Partial<Omit<AgentV2.Info, "id">>): AgentV2.Info =>
  ({ mode: "primary", hidden: false, request: { headers: {}, body: {} }, permissions: [], ...over }) as never

describe("who can be addressed", () => {
  const roster = [
    agent({ id: "nova", name: "Nova", title: "Chief Executive" }),
    agent({ id: "theron", name: "Theron", title: "Bookkeeper" }),
    agent({ id: "general", mode: "subagent" }),
    agent({ id: "title", hidden: true }),
  ]

  test("colleagues only — never the nameless staff, never the machinery", () => {
    // `general` is spawned per task and ends with it; `title` is plumbing. Neither has a chat to
    // receive anything, and addressing one would be talking to a process, not a person.
    expect(ColleagueTool.addressable(roster, "nova").map((a) => String(a.id))).toEqual(["theron"])
  })

  test("never yourself", () => {
    // A colleague messaging its own chat would append to the conversation it is currently having —
    // an infinite regress the model cannot see it is starting.
    expect(ColleagueTool.addressable(roster, "theron").map((a) => String(a.id))).toEqual(["nova"])
  })
})

describe("what the roster looks like to a model routing work", () => {
  test("id first, then who they are and what they own", () => {
    // The id is what `ask` takes, so it leads; the rest is what makes routing a decision rather than
    // a guess.
    const listing = ColleagueTool.formatRoster(
      [{ id: "theron", name: "Theron", title: "Bookkeeper", description: "Owns the ledger" }],
      "nova",
    )
    expect(listing).toBe("theron · Theron · Bookkeeper — Owns the ledger")
  })

  test("an empty roster says what to do instead of returning nothing", () => {
    // "No colleagues" rendered as an empty string reads as a broken tool, and a model that thinks a
    // tool is broken will try it again.
    expect(ColleagueTool.formatRoster([], "nova")).toContain("no colleagues yet")
  })

  test("a nameless colleague still lists under its id", () => {
    expect(ColleagueTool.formatRoster([{ id: "build" }], "nova")).toBe("build · build")
  })
})

describe("who may staff the organization", () => {
  test("only the CEO hires and retires", () => {
    // Not a permission dial — the org chart itself. An officer that could hire would be a second
    // CEO, and an organization with two CEOs has none. The permission check still runs on top,
    // because "Nova may do this" and "this instance allows it now" are different questions.
    expect(ColleagueTool.mayStaff("nova")).toBe(true)
    expect(ColleagueTool.mayStaff("theron")).toBe(false)
    expect(ColleagueTool.mayStaff("")).toBe(false)
  })
})

describe("what the receiver is told about who is asking", () => {
  test("a PEER is a colleague, not a parent", () => {
    // The distinction is durable — it stays in the receiver's transcript — and calling a peer a
    // parent teaches the receiving model that the sender outranks it.
    const header = SessionOrigin.modelHeader({ via: "agent", sessionID: "ses_1", label: "nova", relation: "peer" })
    expect(header).toContain("colleague")
    expect(header).toContain("own judgement")
    expect(header).not.toContain("parent")
  })

  test("a delegation still reads as one", () => {
    // Sub-agents are genuinely subordinate: their work was assigned and their result goes back up.
    const header = SessionOrigin.modelHeader({ via: "agent", sessionID: "ses_1", label: "build" })
    expect(header).toContain("parent agent session")
    expect(header).toContain("delegated task")
  })

  test("the transcript badge names the relationship too", () => {
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1", relation: "peer" })).toMatchObject({
      label: "colleague",
      tone: "agent",
    })
    expect(SessionOrigin.badge({ via: "agent", sessionID: "ses_1" })).toMatchObject({ label: "parent agent" })
  })
})
