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

// 🔴 THE RULE HAD NO CALLER UNTIL 2026-08-22, and the live path contradicted it.
//
// `runner/maintenance.ts` wrote every auto-extracted fact to `session:${sessionID}`, hardcoded.
// Recall DOES read that scope, so it worked — until "Clear chat", which starts a new session and
// takes every automatically-learned fact with it, while the colleague, its brief and its explicit
// `kb remember` memories all survive. The one kind of memory a user never watches being written is
// the one that silently did not last, and the metaphor's promise is "executive agents with
// persistent chats AND MEMORY".
//
// These cases are the whole reason the function exists; they were green while nothing called it.
describe("rememberScope", () => {
  it("🔴 an officer's automatically-learned facts outlive the chat they were learned in", () => {
    // The property the hardcoded scope broke: written to the CABINET, so a cleared chat — a new
    // session id — still recalls them, because `recallScopes` searches `agent:<id>` too.
    const learnedIn = SessionRecall.rememberScope({ sessionID: "ses_first", agentID: "theron" })
    expect(SessionRecall.recallScopes({ sessionID: "ses_second", agentID: "theron", memory: "own" })).toContain(
      learnedIn,
    )
  })

  it("🔴 the officer's cabinet is NOT the scope consolidation promotes out of", () => {
    // The actual pre-2026-08-22 defect, and it was a LEAK rather than a loss. `kb-graph/memory.ts`
    // promotes `source = 'auto-extract'` memories in `session:` scopes into `global` every five
    // minutes, so everything a colleague learned without being asked became readable by EVERY
    // colleague — the filing-cabinet promise inverted, on exactly the memories a user never watches
    // being written. Filing in the cabinet fixes it by construction: consolidation only picks up
    // `session:` scopes.
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: "theron" }).startsWith("session:")).toBe(false)
    // ⚠️ …and the agentless fallback IS session-scoped, which means it still consolidates. That is
    // correct and deliberate: a chat with no officer has no cabinet to file in, and `global` is where
    // an ownerless durable fact belongs.
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: undefined }).startsWith("session:")).toBe(true)
  })

  it("…which the session scope would NOT have done", () => {
    // The negative control, and the exact shape of the bug: a fact written to the first chat's own
    // scope is unreachable from the second, and nothing anywhere reports it missing.
    expect(SessionRecall.recallScopes({ sessionID: "ses_second", agentID: "theron", memory: "own" })).not.toContain(
      "session:ses_first",
    )
  })

  it("writes a durable fact to the officer, not to the open chat", () => {
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: "trader" })).toBe("agent:trader")
  })

  it("falls back to the session when nothing owns the fact", () => {
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: undefined })).toBe("session:ses_1")
    expect(SessionRecall.rememberScope({ sessionID: "ses_1", agentID: "" })).toBe("session:ses_1")
  })
})
