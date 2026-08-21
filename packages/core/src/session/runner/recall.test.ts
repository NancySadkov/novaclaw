import { describe, expect, it } from "bun:test"
import { SessionRecall } from "./recall"

// The roster's load-bearing promise (AGENTS.md — the structural metaphor): an agent's memory is its
// own. These pin the SCOPE SET, which is the only place that promise is expressible — a UI label
// cannot enforce it and a prompt cannot be trusted to.
describe("recallScopes", () => {
  it("gives an officer its own cabinet plus the household's shared facts", () => {
    expect(SessionRecall.recallScopes({ sessionID: "ses_1", agentID: "trader", memory: "own" })).toEqual([
      "session:ses_1",
      "agent:trader",
      "global",
    ])
  })

  it("never puts another agent's scope in reach", () => {
    const scopes = SessionRecall.recallScopes({ sessionID: "ses_1", agentID: "dungeon-master", memory: "own" })
    // The negative is the assertion that matters: the trading desk must not appear because a D&D
    // session asked. A positive-only test passes just as happily when every scope is included.
    expect(scopes).not.toContain("agent:trader")
  })

  it("returns undefined for a throwaway agent so the caller skips recall entirely", () => {
    // "Crashtest Joe" (owner, 2026-08-20): no memory at all. Distinct from an empty scope list —
    // undefined tells the runner not to embed, not to search and not to inject.
    expect(SessionRecall.recallScopes({ sessionID: "ses_1", agentID: "crashtest-joe", memory: "none" })).toBeUndefined()
  })

  it("defaults to own when the profile says nothing", () => {
    expect(SessionRecall.recallScopes({ sessionID: "ses_1", agentID: "build", memory: undefined })).toEqual([
      "session:ses_1",
      "agent:build",
      "global",
    ])
  })

  it("falls back to the old session-plus-global shape when there is no agent", () => {
    // A session with no agent id still recalls what it said and what the household knows; it just has
    // no cabinet of its own. This is the pre-roster behaviour, kept intact.
    expect(SessionRecall.recallScopes({ sessionID: "ses_1", agentID: undefined, memory: "own" })).toEqual([
      "session:ses_1",
      "global",
    ])
    expect(SessionRecall.recallScopes({ sessionID: "ses_1", agentID: "", memory: undefined })).toEqual([
      "session:ses_1",
      "global",
    ])
  })
})

describe("rememberScope", () => {
  it("writes a durable fact to the officer, not to the open chat", () => {
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: "trader" })).toBe("agent:trader")
  })

  it("falls back to the session when nothing owns the fact", () => {
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: undefined })).toBe("session:ses_1")
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: "" })).toBe("session:ses_1")
  })
})
