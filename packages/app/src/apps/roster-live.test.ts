import { describe, expect, test } from "bun:test"
import { chatFor, liveFor, threadOf, type SessionLike } from "./roster-live"

const session = (over: Partial<SessionLike> & { id: string }): SessionLike => ({
  time: { created: 1 },
  ...over,
})

const tokens = (output: number) => ({ input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } })

describe("the ONE chat a colleague has", () => {
  test("is the live root chat bound to that agent", () => {
    const sessions = [
      session({ id: "a", agent: "theron", time: { created: 1 } }),
      session({ id: "b", agent: "kallias", time: { created: 2 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("a")
    expect(chatFor(sessions, "nobody")).toBeUndefined()
  })

  test("a sub-agent thread is never mistaken for the colleague's own chat", () => {
    // The nameless staff carry their officer's agent id through the config walk, so a child would
    // otherwise look exactly like a second chat for the same colleague.
    const sessions = [
      session({ id: "root", agent: "theron", time: { created: 1 } }),
      session({ id: "child", parentID: "root", agent: "theron", time: { created: 9 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("root")
  })

  test("an ARCHIVED chat never wins, however recent", () => {
    // "Clear chat" archives the old conversation and starts fresh. Preferring recency alone would
    // hand the colleague straight back the chat the user just cleared.
    const sessions = [
      session({ id: "old", agent: "theron", time: { created: 1, updated: 99, archived: 100 } }),
      session({ id: "fresh", agent: "theron", time: { created: 50 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("fresh")
  })

  test("with two live chats the most recently touched wins, deterministically", () => {
    const sessions = [
      session({ id: "stale", agent: "theron", time: { created: 1, updated: 2 } }),
      session({ id: "recent", agent: "theron", time: { created: 1, updated: 8 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("recent")
    // Order of the input must not change the answer.
    expect(chatFor([...sessions].reverse(), "theron")?.id).toBe("recent")
  })
})

describe("what the colleague has spent", () => {
  test("rolls up its sub-agent threads — staff spend on their officer's behalf", () => {
    const sessions = [
      session({ id: "root", agent: "theron", tokens: tokens(100) }),
      session({ id: "child", parentID: "root", tokens: tokens(30) }),
      session({ id: "grandchild", parentID: "child", tokens: tokens(7) }),
      session({ id: "elsewhere", agent: "kallias", tokens: tokens(1000) }),
    ]
    expect(liveFor(sessions, "theron").tokens.generated).toBe(137)
  })

  test("a cycle in the parent chain terminates instead of hanging the first screen", () => {
    const sessions = [
      session({ id: "root", agent: "theron", parentID: "loop", tokens: tokens(1) }),
      session({ id: "loop", parentID: "root", tokens: tokens(1) }),
    ]
    // `root` is not a root session here, so the colleague has no chat — and the walk still returns.
    expect(threadOf(sessions, "root").map((item) => item.id)).toEqual(["root", "loop"])
  })
})

describe("what a colleague with no chat yet reports", () => {
  test("nothing invented — no session, no title, zero spend", () => {
    // A brand-new hire has done nothing. Showing a zero rate or an empty title as if it were a
    // measurement is how a roster starts describing work that never happened.
    const live = liveFor([], "theron")
    expect(live).toMatchObject({ sessionID: undefined, title: undefined, updatedAt: undefined })
    expect(live.tokens.generated).toBe(0)
  })

  test("a chat with no title yet reports no title, not an empty string", () => {
    const live = liveFor([session({ id: "a", agent: "theron", title: "   " })], "theron")
    expect(live.title).toBeUndefined()
  })

  test("the auto-generated title is reused verbatim", () => {
    const live = liveFor([session({ id: "a", agent: "theron", title: "Glyph description request" })], "theron")
    expect(live.title).toBe("Glyph description request")
  })
})
