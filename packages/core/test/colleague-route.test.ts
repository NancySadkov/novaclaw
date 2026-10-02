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
  test("Nova reaches descendants through its direct report", () => {
    expect(ColleagueRoute.route({ agent: "nova" }, "theon", roster)).toEqual({
      kind: "officer", recipient: "daedalus", redirected: true,
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

  // 🔴 Regression, measured on the owner's live instance 2026-10-02: `lacedaemon` reported to the
  // human `owner`, Nova also resolves its superior to `owner`, and the equal ids made them a
  // "same tier" — so Nova's `colleague ask` landed in the officer's chat instead of being redirected
  // to its real superior. Sharing the human owner is not a messaging tier.
  const withOwner = [
    ...roster,
    { id: "owner", kind: "human", superior: "owner" },
    { id: "personal", superior: "owner" },
  ] as unknown as AgentV2.Info[]

  test("officers sharing the HUMAN owner are not a same-tier messaging set", () => {
    for (const [agent, requested] of [
      ["nova", "personal"],
      ["personal", "nova"],
    ] as const)
      expect(ColleagueRoute.route({ agent }, requested, withOwner)).toEqual({
        kind: "officer",
        recipient: "owner",
        redirected: true,
      })
  })

  test("a direct report of the owner still reaches the owner directly", () => {
    for (const agent of ["nova", "personal"])
      expect(ColleagueRoute.route({ agent }, "owner", withOwner)).toEqual({
        kind: "officer",
        recipient: "owner",
        redirected: false,
      })
  })
})
