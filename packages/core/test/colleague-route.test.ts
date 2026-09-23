import { describe, expect, test } from "bun:test"
import { ColleagueRoute } from "@novaclaw/core/session/colleague-route"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { AgentV2 } from "@novaclaw/core/agent"

const roster = [
  { id: "nova" },
  { id: "daedalus", superior: "nova" },
  { id: "geryon", superior: "nova" },
  { id: "iris", superior: "daedalus" },
  { id: "theon", superior: "iris" },
  { id: "wren", superior: "geryon" },
] as unknown as AgentV2.Info[]

describe("host-owned colleague routing", () => {
  test("Nova can reach every officer", () => {
    expect(ColleagueRoute.route({ agent: "nova" }, "theon", roster)).toEqual({
      kind: "officer", recipient: "theon", redirected: false,
    })
  })

  test("superior, direct report and same-tier officer remain directly addressable", () => {
    for (const recipient of ["nova", "iris", "geryon"])
      expect(ColleagueRoute.route({ agent: "daedalus" }, recipient, roster)).toEqual({
        kind: "officer", recipient, redirected: false,
      })
  })

  test("an officer cannot skip their superior or cross another branch", () => {
    for (const requested of ["nova", "geryon", "wren"])
      expect(ColleagueRoute.route({ agent: "iris" }, requested, roster)).toEqual({
        kind: "officer", recipient: "daedalus", redirected: true,
      })
  })

  test("a message to a grandchild moves to the direct report on that branch", () => {
    expect(ColleagueRoute.route({ agent: "daedalus" }, "theon", roster)).toEqual({
      kind: "officer", recipient: "iris", redirected: true,
    })
  })

  test("a paused superior remains the real superior for stored messages", () => {
    const withPause = roster.map((agent) => agent.id === "daedalus" ? { ...agent, paused: true } : agent)
    expect(ColleagueRoute.route({ agent: "iris" }, "nova", withPause)).toEqual({
      kind: "officer", recipient: "daedalus", redirected: true,
    })
  })

  test("an anonymous worker reaches its immediate parent session, never Nova", () => {
    const parentID = SessionSchema.ID.make("ses_parent_worker")
    expect(ColleagueRoute.route({ parentID }, "nova", roster)).toEqual({
      kind: "worker-parent", sessionID: parentID, redirected: true,
    })
  })

  test("missing identities and self-delivery fail explicitly", () => {
    expect(ColleagueRoute.route({ agent: "iris" }, "ghost", roster).kind).toBe("unavailable")
    expect(ColleagueRoute.route({ agent: "iris" }, "iris", roster).kind).toBe("unavailable")
  })
})
